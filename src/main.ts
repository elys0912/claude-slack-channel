// エントリポイント。stdout は MCP (JSON-RPC) 専用なので、必ず最初に guard を読み込む。
import './stdio-guard.js';

import path from 'node:path';
import { loadAccess, loadHomeCustom, loadTokens, stateDir } from './config.js';
import type { ParsedAccess, Tokens } from './config.js';
import { errMessage } from './errors.js';
import { Logger } from './log.js';
import { DEFAULT_STALE_MS, InstanceLock, acquireWithRetry, isProcessAlive } from './lock.js';
import { SlackBridge } from './slack.js';
import { startBridgeApp, startDegradedApp } from './app.js';
import type { BridgeAppOptions } from './app.js';
import { replyTimeoutMs } from './watchdog.js';
import { PowerShellConsole, findConsoleScript } from './console.js';
import { HOOK_LOG_FILE, SESSION_TAG_ENV } from './hook-event.js';
import { RESTART_FLAG_FILE } from './session-control.js';
import { isPlaceholder, runPlaceholder } from './placeholder.js';
import { managedSettingsFiles } from './allow-rules.js';

/** リポジトリのルート（dist/src/main.js の 2 つ上） */
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/** 起動失敗時、process.exit の前に undici の後始末を待つ時間 */
const EXIT_SETTLE_MS = 250;
/** 終了処理が固まったときに強制終了するまでの猶予 */
const SHUTDOWN_GRACE_MS = 2000;
/** stdin の終了を取りこぼしていないか確認する間隔 */
const STDIN_POLL_MS = 5000;
/** ロックが取れないとき、縮退モードに入る前に取り直しを試す時間（旧ブリッジの終了処理は SHUTDOWN_GRACE_MS で終わる） */
const LOCK_RETRY_MS = 10000;
const LOCK_RETRY_INTERVAL_MS = 500;

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
  // 同時に動く Slack ブリッジは1つだけ。2つ目は Slack に繋がず縮退モードで動く。
  // 起動し直し（!restart）では旧ブリッジの終了処理と重なるので、少し待ってから諦める。
  // 強制終了（!restart force）で解放されずに残ったロックは、持ち主の pid が死んでいれば取る。
  // 動いている間に別のインスタンスにロックを取られたら（スリープ明けなど）、Slack との接続を切って終わる（2 本の接続でメッセージが分かれないように）
  let stopApp: (() => Promise<void>) | undefined;
  const lock = new InstanceLock(path.join(dir, 'instance.lock'), {
    isAlive: isProcessAlive,
    onLost: (holder) => {
      process.stderr.write(`[slackbridge] 別のインスタンス（pid=${holder.pid}）がロックを取ったので、Slack との接続を切って終わる\n`);
      logger.error(`ロックを別のインスタンス（pid=${holder.pid}）に取られた。後片付けして終わる`);
      void stopApp?.();
    },
  });
  const lockResult = await acquireWithRetry(lock, { timeoutMs: LOCK_RETRY_MS, intervalMs: LOCK_RETRY_INTERVAL_MS });
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
      `allowFrom=${access.allowFrom.length}人 channels=${access.channels?.length ?? 0}件 download=${tokens.downloadDir ? 'on' : 'off'} allowAll=${tokens.sessionAllowAll ? 'on' : 'off'} degraded=${degraded}`
  );

  if (degraded) {
    // 縮退の間もロックを取り直し、取れたら同じ MCP の接続のまま通常のブリッジに戻る。設定はそのときに読み直す
    const app = await startDegradedApp({
      logger,
      recover: {
        lock,
        intervalMs: DEFAULT_STALE_MS,
        start: async (server) => {
          const fresh = { tokens: loadTokens(dir), access: loadAccess(dir) };
          const slack = await connectSlack(fresh.tokens, fresh.access, logger);
          const running = await startBridgeApp({ ...bridgeAppOptions(dir, logger, lock, fresh.tokens, fresh.access, slack), server });
          process.stderr.write('[slackbridge] ロックを取り直したので、Slack に接続して通常のブリッジに戻った\n');
          return running.stop;
        },
      },
    });
    // 戻った後に別のインスタンスにロックを取られたら、通常モードと同じく接続を切って終わる
    stopApp = app.stop;
    installShutdown(logger, app.stop);
    return;
  }

  let slack: ConnectedSlack;
  try {
    slack = await connectSlack(tokens, access, logger);
  } catch (e) {
    return abort(logger, 'Slack への接続確認に失敗', e, () => lock.release());
  }

  // 終了処理は Socket Mode の接続を待つ前に登録する。開始に失敗したら startBridgeApp が後片付けしてから投げる
  await startBridgeApp({
    ...bridgeAppOptions(dir, logger, lock, tokens, access, slack),
    onCleanupReady: (stop) => {
      stopApp = stop;
      installShutdown(logger, stop);
    },
  });
}

interface ConnectedSlack {
  bridge: SlackBridge;
  botUserId: string;
}

/** Slack に接続して確かめる。失敗したら bridge を止めてから投げる */
async function connectSlack(tokens: Tokens, access: ParsedAccess, logger: Logger): Promise<ConnectedSlack> {
  const bridge = new SlackBridge({ botToken: tokens.botToken, appToken: tokens.appToken, access, logger });
  try {
    const init = await bridge.init();
    logger.info(`Slack 接続確認 OK bot=${init.botUserId} team=${init.teamId} dm=${init.dmChannelCount}件`);
    return { bridge, botUserId: init.botUserId };
  } catch (e) {
    await bridge.stop();
    throw e;
  }
}

/** 通常のブリッジの設定（起動したときと、縮退モードから戻るときで同じもの） */
function bridgeAppOptions(
  dir: string,
  logger: Logger,
  lock: InstanceLock,
  tokens: Tokens,
  access: ParsedAccess,
  { bridge, botUserId }: ConnectedSlack
): BridgeAppOptions {
  return {
    bridge,
    logger,
    lock,
    replyTimeoutMs: replyTimeoutMs(),
    console: consoleAccess(logger),
    workDir: process.cwd(),
    home: {
      users: access.allowFrom,
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
    // start.ps1 から起動されたときだけ値がある。無ければ（手で起動したなど）今までどおり全部の行を扱う
    sessionTag: process.env[SESSION_TAG_ENV] || undefined,
    restartFlagFile: path.join(dir, RESTART_FLAG_FILE),
    download: tokens.downloadDir ? { bridge, dir: tokens.downloadDir } : undefined,
    sessionAllowAll: tokens.sessionAllowAll === true,
    managedSettingsFiles: () => managedSettingsFiles(),
    // 起動スクリプトは作業フォルダーで claude.exe を起動し、MCP サーバーも同じ作業フォルダーで動く。
    // channel セッションの設定ファイルは -SettingsFile で替えられるので、起動スクリプトが渡した場所を優先する
    denyFiles: [
      process.env.SLACK_CHANNEL_SETTINGS_FILE ?? path.join(repoRoot, 'config', 'channel-settings.json'),
      path.join(process.cwd(), '.claude', 'settings.json'),
      path.join(process.cwd(), '.claude', 'settings.local.json'),
    ],
  };
}

/** 画面の読み取りに使う console.ps1 が見つかれば、その実装を返す。Windows 以外・見つからなければ undefined */
function consoleAccess(logger: Logger): PowerShellConsole | undefined {
  if (process.platform !== 'win32') return undefined;
  const script = findConsoleScript();
  if (!script) {
    logger.warn('scripts/console.ps1 が見つからないので、!screen と画面のボタンは使えない');
    return undefined;
  }
  // ブリッジの親は claude.exe（MCP サーバーとして起動される）。そのコンソールの画面を操作する
  return new PowerShellConsole(script, process.ppid, logger);
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

function startBridge(): void {
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
}

// start.ps1 が local スコープに登録した slackbridge（普段のセッションで読み込まれる）は、
// 状態ディレクトリにもロックにも触らずに待つだけ（src/placeholder.ts）
if (isPlaceholder()) {
  runPlaceholder().catch((e: unknown) => {
    process.stderr.write(`[slackbridge] 起動に失敗: ${errMessage(e)}\n`);
    process.exit(1);
  });
} else {
  startBridge();
}
