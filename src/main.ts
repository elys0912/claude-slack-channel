// エントリポイント。stdout は MCP (JSON-RPC) 専用なので、必ず最初に guard を読み込む。
import './stdio-guard.js';

import path from 'node:path';
import { loadAccess, loadTokens, stateDir } from './config.js';
import type { ParsedAccess, Tokens } from './config.js';
import { errMessage } from './errors.js';
import { Logger } from './log.js';
import { InstanceLock } from './lock.js';
import { SlackBridge } from './slack.js';
import { startBridgeApp, startDegradedApp } from './app.js';
import { replyTimeoutMs } from './watchdog.js';

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

async function main(dir: string, logger: Logger): Promise<void> {
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
    const app = await startDegradedApp({ logger });
    installShutdown(logger, app.stop);
    return;
  }

  const bridge = new SlackBridge({ botToken: tokens.botToken, appToken: tokens.appToken, access, logger });
  try {
    const init = await bridge.init();
    logger.info(`Slack 接続確認 OK bot=${init.botUserId} team=${init.teamId} dm=${init.dmChannelCount}件`);
  } catch (e) {
    return abort(logger, 'Slack への接続確認に失敗', e, async () => {
      lock.release();
      await bridge.stop();
    });
  }

  // 終了処理は Socket Mode の接続を待つ前に登録する。開始に失敗したら startBridgeApp が後片付けしてから投げる
  await startBridgeApp({
    bridge,
    logger,
    lock,
    onCleanupReady: (stop) => installShutdown(logger, stop),
    replyTimeoutMs: replyTimeoutMs(),
  });
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

// Logger はプロセスで 1 つ。起動前の例外も main() 内も同じものに書く
const stateDirectory = stateDir();
const logger = createLogger(stateDirectory);

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('unhandledRejection', reason);
});
process.on('uncaughtException', (e: unknown) => {
  logger.error('uncaughtException', e);
});

main(stateDirectory, logger).catch((e: unknown) => {
  process.stderr.write(`[slackbridge] 起動に失敗: ${errMessage(e)}\n`);
  logger.error('起動に失敗', e);
  void exitWithError(1);
});
