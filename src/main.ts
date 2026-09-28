// エントリポイント。stdout は MCP (JSON-RPC) 専用なので、必ず最初に guard を読み込む。
import './stdio-guard.js';

import path from 'node:path';
import { loadAccess, loadTokens, stateDir } from './config.js';
import { Logger } from './log.js';
import { InstanceLock } from './lock.js';
import { SlackBridge } from './slack.js';
import { ChannelServer } from './mcp.js';
import {
  PendingPermissions,
  buildExpiredBlocks,
  buildPermissionBlocks,
  buildResolvedBlocks,
} from './permission.js';
import type { PermissionRequest } from './permission.js';

const REACTION_OK = 'white_check_mark';
const REACTION_NG = 'x';
const REACTION_SEEN = 'eyes';

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 起動失敗時の終了。undici（HTTP クライアント）の後始末が終わる前に process.exit すると
 * libuv がアサートで落ちるので、少しだけ待ってから抜ける。
 */
async function exitWithError(code: number): Promise<never> {
  await new Promise((r) => setTimeout(r, 250));
  process.exit(code);
}

async function main(): Promise<void> {
  // --- 1. stateDir と Logger ------------------------------------------------
  const dir = stateDir();
  const logger = new Logger({ file: path.join(dir, 'logs', 'bridge.log') });
  logger.setName('bridge');

  // --- 2. 単一インスタンスのロック ------------------------------------------
  const lock = new InstanceLock(path.join(dir, 'instance.lock'));
  const lockResult = lock.tryAcquire();
  const degraded = !lockResult.acquired;
  if (!lockResult.acquired) {
    process.stderr.write(
      `[slackbridge] 別のインスタンスが動いている（pid=${lockResult.holder.pid}）。Slack には接続せず、MCP サーバーのみ起動する\n`
    );
    logger.warn(`ロック取得に失敗（保持者 pid=${lockResult.holder.pid}）。縮退モードで起動する`);
  }

  // --- 3. トークンとアクセス許可リスト --------------------------------------
  let tokens;
  let access;
  try {
    tokens = loadTokens(dir);
    access = loadAccess(dir);
  } catch (e) {
    process.stderr.write(`[slackbridge] 設定の読み込みに失敗: ${errMessage(e)}\n`);
    logger.error('設定の読み込みに失敗', errMessage(e));
    lock.release();
    await exitWithError(1);
    return;
  }

  logger.info(
    `起動 pid=${process.pid} node=${process.version} stateDir=${dir} ` +
      `allowFrom=${access.allowFrom.length}人 degraded=${degraded}`
  );

  // --- 縮退モード: MCP のみ起動して、ツールはエラーを返す --------------------
  if (degraded) {
    const busy = async (): Promise<string> =>
      'error: 別のインスタンスが動いているため、この Slack ブリッジは送信できない';
    const server = new ChannelServer({
      logger,
      onReply: busy,
      onReact: busy,
      onEdit: busy,
      onPermissionRequest: () => {
        logger.warn('縮退モードのため permission_request を無視する');
      },
    });
    await server.connectStdio();
    installShutdown(logger, async () => {
      await server.close();
    });
    return;
  }

  // --- 4. Slack と MCP の起動 -----------------------------------------------
  const bridge = new SlackBridge({
    botToken: tokens.botToken,
    appToken: tokens.appToken,
    access,
    logger,
  });

  let init;
  try {
    init = await bridge.init();
  } catch (e) {
    process.stderr.write(`[slackbridge] Slack への接続確認に失敗: ${errMessage(e)}\n`);
    logger.error('Slack への接続確認に失敗', errMessage(e));
    await bridge.stop();
    lock.release();
    await exitWithError(1);
    return;
  }
  logger.info(`Slack 接続確認 OK bot=${init.botUserId} team=${init.teamId} dm=${init.dmChannels.size}件`);

  const pending = new PendingPermissions();
  // request_id -> ボタンを出したメッセージ（確定時に書き換えるため覚えておく）
  const posted = new Map<string, { channel: string; ts: string }[]>();

  const server = new ChannelServer({
    logger,
    onReply: async ({ chat_id, text, thread_ts }) => {
      try {
        const res = await bridge.postText(chat_id, text, thread_ts);
        return `sent (${res.ts.length} message(s))`;
      } catch (e) {
        logger.error('reply に失敗', e);
        return `error: ${errMessage(e)}`;
      }
    },
    onReact: async ({ chat_id, message_id, emoji }) => {
      try {
        await bridge.addReaction(chat_id, message_id, emoji.replace(/^:|:$/g, ''));
        return 'reacted';
      } catch (e) {
        logger.error('react に失敗', e);
        return `error: ${errMessage(e)}`;
      }
    },
    onEdit: async ({ chat_id, message_id, text }) => {
      try {
        await bridge.updateText(chat_id, message_id, text);
        return 'edited';
      } catch (e) {
        logger.error('edit_message に失敗', e);
        return `error: ${errMessage(e)}`;
      }
    },
    onPermissionRequest: async (req: PermissionRequest) => {
      pending.prune();
      pending.add(req);
      const { text, blocks } = buildPermissionBlocks(req);
      const results = await bridge.postToAll(text, blocks);
      posted.set(
        req.request_id,
        results.filter((r) => r.ts !== '')
      );
      logger.info(`permission_request を配信 id=${req.request_id} tool=${req.tool_name} 宛先=${results.length}`);
    },
  });

  await server.connectStdio();

  // 確定した permission のボタンメッセージを書き換える
  const resolvePosted = async (
    req: PermissionRequest,
    behavior: 'allow' | 'deny',
    byUserId: string
  ): Promise<void> => {
    const targets = posted.get(req.request_id) ?? [];
    posted.delete(req.request_id);
    const { text, blocks } = buildResolvedBlocks(req, behavior, byUserId);
    for (const t of targets) {
      try {
        await bridge.updateBlocks(t.channel, t.ts, text, blocks);
      } catch (e) {
        logger.warn(`permission メッセージの書き換えに失敗 channel=${t.channel}`, e);
      }
    }
  };

  await bridge.start({
    onMessage: async (result, raw) => {
      if (result.kind === 'drop') {
        logger.debug(`受信を破棄 reason=${result.reason}`);
        return;
      }

      if (result.kind === 'verdict') {
        const req = pending.take(result.verdict.requestId);
        await server.sendVerdict(result.verdict);
        logger.info(
          `verdict を送信 id=${result.verdict.requestId} behavior=${result.verdict.behavior} known=${req !== undefined}`
        );
        if (raw.channel && raw.ts) {
          await bridge.addReaction(
            raw.channel,
            raw.ts,
            result.verdict.behavior === 'allow' ? REACTION_OK : REACTION_NG
          );
        }
        if (req) {
          await resolvePosted(req, result.verdict.behavior, raw.user ?? '');
        }
        return;
      }

      await server.pushMessage(result.content, result.meta);
      if (raw.channel && raw.ts) {
        await bridge.addReaction(raw.channel, raw.ts, REACTION_SEEN);
      }
    },

    onAction: async (parsed, ctx) => {
      if (!parsed.ok) {
        logger.warn(`block_actions を無視 reason=${parsed.reason}`);
        return;
      }

      if (parsed.kind === 'verdict') {
        const req = pending.take(parsed.verdict.requestId);
        if (!req) {
          logger.warn(`期限切れの permission id=${parsed.verdict.requestId}`);
          if (ctx.channelId && ctx.messageTs) {
            const { text, blocks } = buildExpiredBlocks(parsed.verdict.requestId);
            try {
              await bridge.updateBlocks(ctx.channelId, ctx.messageTs, text, blocks);
            } catch (e) {
              logger.warn('期限切れ表示への書き換えに失敗', e);
            }
          }
          return;
        }
        await server.sendVerdict(parsed.verdict);
        logger.info(`verdict を送信（ボタン） id=${parsed.verdict.requestId} behavior=${parsed.verdict.behavior}`);
        await resolvePosted(req, parsed.verdict.behavior, ctx.userId ?? '');
        return;
      }

      // see_more: input_preview の全文をスレッドに送る
      const req = pending.get(parsed.requestId);
      if (!ctx.channelId || !ctx.messageTs) return;
      if (!req) {
        try {
          await bridge.postText(
            ctx.channelId,
            `⌛ permission request ${parsed.requestId} は既に期限切れ`,
            ctx.messageTs,
          );
        } catch (e) {
          logger.warn('see_more の送信に失敗', e);
        }
        return;
      }
      try {
        await bridge.postBlocks(
          ctx.channelId,
          req.input_preview,
          [
            {
              type: 'rich_text',
              elements: [
                {
                  type: 'rich_text_preformatted',
                  elements: [{ type: 'text', text: req.input_preview }],
                },
              ],
            },
          ],
          ctx.messageTs,
        );
      } catch (e) {
        logger.warn('see_more の送信に失敗', e);
      }
    },
  });

  logger.info('Slack ブリッジ稼働中');

  installShutdown(logger, async () => {
    await bridge.stop();
    await server.close();
    lock.release();
  });
}

// --- 6. 終了処理 -------------------------------------------------------------

function installShutdown(logger: Logger, cleanup: () => Promise<void>): void {
  let shuttingDown = false;

  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`終了処理開始 理由=${reason}`);
    void cleanup()
      .then(() => {
        logger.info(`終了処理完了 理由=${reason}`);
      })
      .catch((e: unknown) => {
        logger.error(`終了処理で例外 理由=${reason}`, e);
      });
    // 後片付けが固まった場合の保険
    setTimeout(() => {
      logger.info(`終了（強制） 理由=${reason}`);
      process.exit(0);
    }, 2000).unref();
  };

  process.stdin.on('end', () => shutdown('stdin end'));
  process.stdin.on('close', () => shutdown('stdin close'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));

  setInterval(() => {
    if (process.stdin.destroyed || process.stdin.readableEnded) {
      shutdown('stdin destroyed/ended（監視ループ検知）');
    }
  }, 5000).unref();
}

// --- 7. 落ちない ------------------------------------------------------------

const bootLogger = new Logger({ file: path.join(stateDir(), 'logs', 'bridge.log') });
bootLogger.setName('bridge');

process.on('unhandledRejection', (reason: unknown) => {
  bootLogger.error('unhandledRejection', reason);
});
process.on('uncaughtException', (e: unknown) => {
  bootLogger.error('uncaughtException', e);
});

main().catch((e: unknown) => {
  process.stderr.write(`[slackbridge] 起動に失敗: ${errMessage(e)}\n`);
  bootLogger.error('起動に失敗', e);
  void exitWithError(1);
});
