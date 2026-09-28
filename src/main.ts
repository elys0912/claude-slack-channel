// エントリポイント。stdout は MCP (JSON-RPC) 専用なので、必ず最初に guard を読み込む。
import './stdio-guard.js';

import path from 'node:path';
import { loadAccess, loadTokens, stateDir } from './config.js';
import type { ParsedAccess, Tokens } from './config.js';
import { errMessage } from './errors.js';
import { Logger } from './log.js';
import { InstanceLock } from './lock.js';
import { SlackBridge } from './slack.js';
import type { ActionContext, InboundRef } from './slack.js';
import { ChannelServer } from './mcp.js';
import type { McpDeps } from './mcp.js';
import { PermissionRelay } from './permission-relay.js';
import { preformattedBlock } from './permission.js';
import type { ActionParse } from './permission.js';
import type { GateResult } from './gate.js';

// Slack 側で「読んだ」「許可した」「拒否した」を示すリアクション
const REACTION_SEEN = 'eyes';
const REACTION_ALLOW = 'white_check_mark';
const REACTION_DENY = 'x';

function createLogger(dir: string): Logger {
  const logger = new Logger({ file: path.join(dir, 'logs', 'bridge.log') });
  logger.setName('bridge');
  return logger;
}

/**
 * 起動失敗時の終了。undici（HTTP クライアント）の後始末が終わる前に process.exit すると
 * libuv がアサートで落ちるので、少しだけ待ってから抜ける。
 */
async function exitWithError(code: number): Promise<never> {
  await new Promise((r) => setTimeout(r, 250));
  process.exit(code);
}

/** 起動を諦める。stderr（Claude Code の /mcp で見える）とログの両方に理由を残す */
async function abort(logger: Logger, what: string, e: unknown, cleanup: () => Promise<void> | void): Promise<never> {
  process.stderr.write(`[slackbridge] ${what}: ${errMessage(e)}\n`);
  logger.error(what, errMessage(e));
  await cleanup();
  return exitWithError(1);
}

// --- 起動 ---------------------------------------------------------------------

async function main(): Promise<void> {
  const dir = stateDir();
  const logger = createLogger(dir);

  // 同時に動く Slack ブリッジは1つだけ。2つ目は Slack に繋がず縮退モードで動く
  const lock = new InstanceLock(path.join(dir, 'instance.lock'));
  const lockResult = lock.tryAcquire();
  const degraded = !lockResult.acquired;
  if (!lockResult.acquired) {
    process.stderr.write(
      `[slackbridge] 別のインスタンスが動いている（pid=${lockResult.holder.pid}）。Slack には接続せず、MCP サーバーのみ起動する\n`
    );
    logger.warn(`ロック取得に失敗（保持者 pid=${lockResult.holder.pid}）。縮退モードで起動する`);
  }

  let tokens: Tokens;
  let access: ParsedAccess;
  try {
    tokens = loadTokens(dir);
    access = loadAccess(dir);
  } catch (e) {
    return abort(logger, '設定の読み込みに失敗', e, () => lock.release());
  }

  logger.info(
    `起動 pid=${process.pid} node=${process.version} stateDir=${dir} ` +
      `allowFrom=${access.allowFrom.length}人 degraded=${degraded}`
  );

  if (degraded) {
    await runDegraded(logger);
  } else {
    await runBridge(tokens, access, logger, lock);
  }
}

/** 縮退モード: MCP サーバーだけ起動し、ツールはすべてエラーを返す */
async function runDegraded(logger: Logger): Promise<void> {
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

  installShutdown(logger, () => server.close());
}

/** 通常モード: Slack と Claude Code（MCP）をつないで中継を始める */
async function runBridge(tokens: Tokens, access: ParsedAccess, logger: Logger, lock: InstanceLock): Promise<void> {
  const bridge = new SlackBridge({ botToken: tokens.botToken, appToken: tokens.appToken, access, logger });

  try {
    const init = await bridge.init();
    logger.info(`Slack 接続確認 OK bot=${init.botUserId} team=${init.teamId} dm=${init.dmChannels.size}件`);
  } catch (e) {
    return abort(logger, 'Slack への接続確認に失敗', e, async () => {
      await bridge.stop();
      lock.release();
    });
  }

  // server と relay は互いを参照する。relay を使うのは接続後なので、宣言順はこれでよい
  const server: ChannelServer = new ChannelServer({
    logger,
    ...createToolHandlers(bridge, logger),
    onPermissionRequest: (req) => relay.request(req),
  });
  const relay: PermissionRelay = new PermissionRelay(bridge, server, logger);
  const wiring: Wiring = { bridge, server, relay, logger };

  await server.connectStdio();
  await bridge.start({
    onMessage: (result, raw) => handleMessage(wiring, result, raw),
    onAction: (parsed, ctx) => handleAction(wiring, parsed, ctx),
  });
  logger.info('Slack ブリッジ稼働中');

  installShutdown(logger, async () => {
    await bridge.stop();
    await server.close();
    lock.release();
  });
}

// --- Claude → Slack（MCP ツールの実体） ----------------------------------------

type ToolHandlers = Pick<McpDeps, 'onReply' | 'onReact' | 'onEdit'>;

/** reply / react / edit_message の実体。失敗しても投げず、Claude が読めるエラー文を返す */
function createToolHandlers(bridge: SlackBridge, logger: Logger): ToolHandlers {
  const run = async (tool: string, action: () => Promise<string>): Promise<string> => {
    try {
      return await action();
    } catch (e) {
      logger.error(`${tool} に失敗`, e);
      return `error: ${errMessage(e)}`;
    }
  };

  return {
    onReply: ({ chat_id, text, thread_ts }) =>
      run('reply', async () => {
        const res = await bridge.postText(chat_id, text, thread_ts);
        return `sent (${res.ts.length} message(s))`;
      }),

    onReact: ({ chat_id, message_id, emoji }) =>
      run('react', async () => {
        // Claude が `:eyes:` のようにコロン付きで渡してきても受け付ける
        await bridge.addReaction(chat_id, message_id, emoji.replace(/^:|:$/g, ''));
        return 'reacted';
      }),

    onEdit: ({ chat_id, message_id, text }) =>
      run('edit_message', async () => {
        await bridge.updateText(chat_id, message_id, text);
        return 'edited';
      }),
  };
}

// --- Slack → Claude（受信イベントの処理） --------------------------------------

interface Wiring {
  bridge: SlackBridge;
  server: ChannelServer;
  relay: PermissionRelay;
  logger: Logger;
}

/** DM で届いたメッセージ。`yes xxxxx` / `no xxxxx` なら許可の回答、それ以外は Claude へ中継する */
async function handleMessage({ bridge, server, relay, logger }: Wiring, result: GateResult, raw: InboundRef): Promise<void> {
  switch (result.kind) {
    case 'drop':
      logger.debug(`受信を破棄 reason=${result.reason}`);
      return;

    case 'verdict':
      await relay.answerByText(result.verdict, raw.user ?? '');
      if (raw.channel && raw.ts) {
        const reaction = result.verdict.behavior === 'allow' ? REACTION_ALLOW : REACTION_DENY;
        await bridge.addReaction(raw.channel, raw.ts, reaction);
      }
      return;

    case 'deliver':
      if (raw.channel && raw.threadTs) relay.rememberThread(raw.channel, raw.threadTs);
      await server.pushMessage(result.content, result.meta);
      if (raw.channel && raw.ts) await bridge.addReaction(raw.channel, raw.ts, REACTION_SEEN);
      return;
  }
}

/** permission request のボタン（Allow / Deny / See more）が押されたとき */
async function handleAction(wiring: Wiring, parsed: ActionParse, ctx: ActionContext): Promise<void> {
  if (!parsed.ok) {
    wiring.logger.warn(`block_actions を無視 reason=${parsed.reason}`);
    return;
  }

  if (parsed.kind === 'verdict') {
    const pressed = ctx.channelId && ctx.messageTs ? { channel: ctx.channelId, ts: ctx.messageTs } : undefined;
    await wiring.relay.answerByButton(parsed.verdict, ctx.userId ?? '', pressed);
    return;
  }

  await sendFullPreview(wiring, parsed.requestId, ctx);
}

/** See more: ボタンのメッセージでは省略した input_preview の全文をスレッドに送る */
async function sendFullPreview({ bridge, relay, logger }: Wiring, requestId: string, ctx: ActionContext): Promise<void> {
  if (!ctx.channelId || !ctx.messageTs) return;

  const req = relay.lookup(requestId);
  try {
    if (req) {
      await bridge.postBlocks(ctx.channelId, req.input_preview, [preformattedBlock(req.input_preview)], ctx.messageTs);
    } else {
      await bridge.postText(ctx.channelId, `⌛ permission request ${requestId} は既に期限切れ`, ctx.messageTs);
    }
  } catch (e) {
    logger.warn('see_more の送信に失敗', e);
  }
}

// --- 終了処理 -------------------------------------------------------------------

/** Claude Code が終了したら（stdin が閉じたら）後片付けして抜ける */
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

  // stdin のイベントを取りこぼした場合に備えて、定期的にも確認する
  setInterval(() => {
    if (process.stdin.destroyed || process.stdin.readableEnded) {
      shutdown('stdin destroyed/ended（監視ループ検知）');
    }
  }, 5000).unref();
}

// --- 予期しない例外でもプロセスを落とさない ---------------------------------------

const bootLogger = createLogger(stateDir());

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
