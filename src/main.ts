// エントリポイント。stdout は MCP (JSON-RPC) 専用なので、必ず最初に guard を読み込む。
import './stdio-guard.js';

import path from 'node:path';
import { loadAccess, loadHomeCustom, loadTokens, stateDir } from './config.js';
import type { ParsedAccess, Tokens } from './config.js';
import { errMessage } from './errors.js';
import { Logger } from './log.js';
import { InstanceLock } from './lock.js';
import { SlackBridge } from './slack.js';
import { startBridgeApp, startDegradedApp } from './app.js';
import { replyTimeoutMs } from './watchdog.js';
import { PowerShellConsole, findConsoleScript } from './console.js';
import { HOOK_LOG_FILE } from './hook-event.js';
import { RESTART_FLAG_FILE } from './session-control.js';

/** リポジトリのルート（dist/src/main.js の 2 つ上） */
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/** 起動失敗時、process.exit の前に undici の後始末を待つ時間 */
const EXIT_SETTLE_MS = 250;
/** 終了処理が固まったときに強制終了するまでの猶予 */
const SHUTDOWN_GRACE_MS = 2000;
/** stdin の終了を取りこぼしていないか確認する間隔 */
const STDIN_POLL_MS = 5000;

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
  await new Promise((r) => setTimeout(r, EXIT_SETTLE_MS));
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
      `allowFrom=${access.allowFrom.length}人 channels=${access.channels?.length ?? 0}件 download=${tokens.downloadDir ? 'on' : 'off'} degraded=${degraded}`
  );

  if (degraded) {
    const app = await startDegradedApp({ logger });
    installShutdown(logger, app.stop);
    return;
  }

  const bridge = new SlackBridge({ botToken: tokens.botToken, appToken: tokens.appToken, access, logger });
  let botUserId: string;
  try {
    const init = await bridge.init();
    botUserId = init.botUserId;
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
    console: consoleAccess(logger),
    home: {
      users: access.allowFrom,
      workDir: process.cwd(),
      channelCount: access.channels?.length ?? 0,
      botUserId,
      loadCustom: () => {
        try {
          return loadHomeCustom(dir);
        } catch (e) {
          logger.warn('home.json を読めなかったので既定の文面にする', errMessage(e));
          return undefined;
        }
      },
    },
    allowExtraFile: path.join(dir, 'allow-extra.json'),
    hookInboxFile: path.join(dir, HOOK_LOG_FILE),
    restartFlagFile: path.join(dir, RESTART_FLAG_FILE),
    download: tokens.downloadDir ? { bridge, dir: tokens.downloadDir } : undefined,
    // 起動スクリプトは作業フォルダーで claude.exe を起動し、MCP サーバーも同じ作業フォルダーで動く。
    // channel セッションの設定ファイルは -SettingsFile で替えられるので、起動スクリプトが渡した場所を優先する
    denyFiles: [
      process.env.SLACK_CHANNEL_SETTINGS_FILE ?? path.join(repoRoot, 'config', 'channel-settings.json'),
      path.join(process.cwd(), '.claude', 'settings.json'),
      path.join(process.cwd(), '.claude', 'settings.local.json'),
    ],
  });
}

/** 画面の読み取りに使う console.ps1 が見つかれば、その実装を返す。Windows 以外・見つからなければ undefined */
function consoleAccess(logger: Logger): PowerShellConsole | undefined {
  if (process.platform !== 'win32') return undefined;
  const script = findConsoleScript();
  if (!script) {
    logger.warn('scripts/console.ps1 が見つからないので、!screen と画面のボタンは使えない');
    return undefined;
  }
  return new PowerShellConsole(script);
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
    }, SHUTDOWN_GRACE_MS).unref();
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
  }, STDIN_POLL_MS).unref();
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
