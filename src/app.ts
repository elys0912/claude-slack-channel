// Slack と Claude Code（MCP）をつなぐ配線。import 時の副作用は持たない（プロセス周りは main.ts）。
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { errMessage } from './errors.js';
import type { Logger } from './log.js';
import type { InstanceLock } from './lock.js';
import type { SlackBridge, ActionContext, InboundRef } from './slack.js';
import { ChannelServer } from './mcp.js';
import type { McpDeps } from './mcp.js';
import { PermissionRelay } from './permission-relay.js';
import { revealInvisible } from './permission.js';
import type { ActionParse } from './permission.js';
import type { GateResult } from './gate.js';
import { ResponseWatchdog, buildNoResponseText } from './watchdog.js';
import type { ConsoleAccess } from './console.js';
import { ScreenRelay, screenShowButton } from './screen-relay.js';
import { RuleRelay } from './rule-relay.js';
import { AllowRuleStore, readDeny } from './allow-rules.js';
import { buildForbiddenHomeView, buildHomeView } from './home.js';

// Slack 側で「読んだ」「許可した」「拒否した」を示すリアクション
export const REACTION = {
  SEEN: 'eyes',
  ALLOW: 'white_check_mark',
  DENY: 'x',
} as const;

// --- 依存の型（テストで差し替えられるよう、使うメソッドだけに絞る） -------------

/** MCP ツール（reply / react / edit_message）が使う Slack 側の操作 */
export type ToolBridge = Pick<SlackBridge, 'postText' | 'addReaction' | 'updateText'>;

/** 受信処理・起動停止まで含めた Slack 側の操作 */
export type AppBridge = Pick<
  SlackBridge,
  'start' | 'stop' | 'postText' | 'postBlocks' | 'addReaction' | 'updateText' | 'postToAll' | 'updateBlocks'
> &
  Partial<Pick<SlackBridge, 'publishHome'>>;

/** 受信処理が使う MCP サーバー側の操作 */
export type AppServer = Pick<ChannelServer, 'pushMessage'>;

/** 受信処理が使う permission relay の操作 */
export type AppRelay = Pick<PermissionRelay, 'answerByText' | 'answerByButton' | 'rememberThread' | 'lookup'>;

/** 無応答の見張りのうち、受信処理が使う操作 */
export type AppWatchdog = Pick<ResponseWatchdog, 'delivered'>;
export type AppScreen = Pick<ScreenRelay, 'show' | 'pick'>;
export type AppRules = Pick<RuleRelay, 'propose' | 'confirm' | 'list' | 'remove'>;

export interface Wiring {
  bridge: AppBridge;
  server: AppServer;
  relay: AppRelay;
  logger: Logger;
  watchdog?: AppWatchdog | undefined;
  /** ターミナル画面の確認・選択（無ければ !screen と画面のボタンは使えない） */
  screen?: AppScreen | undefined;
  /** 許可リストへの追加（無ければ「今後も許可」は今回の許可だけになる） */
  rules?: AppRules | undefined;
}

/** Claude に渡さず、ブリッジ自身が処理するコマンド */
const COMMAND_RE = /^\s*!(screen|rules)\s*$/i;

// --- Claude → Slack（MCP ツールの実体） ----------------------------------------

export type ToolHandlers = Pick<McpDeps, 'onReply' | 'onReact' | 'onEdit'>;

/**
 * reply / react / edit_message の実体。失敗しても投げず、Claude が読めるエラー文を返す。
 * onActivity はツールが呼ばれるたびに（成否によらず）呼ぶ。無応答の見張りを解くのに使う。
 */
export function createToolHandlers(bridge: ToolBridge, logger: Logger, onActivity?: () => void): ToolHandlers {
  const run = async (tool: string, action: () => Promise<string>): Promise<string> => {
    onActivity?.();
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

/** 縮退モード: ツールはすべてエラーを返し、permission_request は無視する */
export function createDegradedDeps(logger: Logger): McpDeps {
  const busy = async (): Promise<string> =>
    'error: 別のインスタンスが動いているため、この Slack ブリッジは送信できない';

  return {
    logger,
    onReply: busy,
    onReact: busy,
    onEdit: busy,
    onPermissionRequest: () => {
      logger.warn('縮退モードのため permission_request を無視する');
    },
  };
}

// --- Slack → Claude（受信イベントの処理） --------------------------------------

/** DM か許可チャンネルで届いたメッセージ。保留中の ID への `yes xxxxx` / `no xxxxx` なら許可の回答、それ以外は Claude へ中継する */
export async function handleMessage(
  { bridge, server, relay, logger, watchdog, screen, rules }: Wiring,
  result: GateResult,
  raw: InboundRef
): Promise<void> {
  // `!screen` / `!rules` は Claude に渡さずにここで処理する（Claude が止まっていても使えるように）
  const command = result.kind === 'deliver' ? COMMAND_RE.exec(result.content)?.[1]?.toLowerCase() : undefined;
  if (command && raw.channel && raw.threadTs) {
    if (raw.ts) await bridge.addReaction(raw.channel, raw.ts, REACTION.SEEN);
    if (command === 'screen') {
      if (screen) await screen.show(raw.channel, raw.threadTs);
      else await bridge.postText(raw.channel, '⚠️ このブリッジでは !screen を使えない', raw.threadTs);
    } else if (rules) {
      await rules.list(raw.channel, raw.threadTs);
    } else {
      await bridge.postText(raw.channel, '⚠️ このブリッジでは !rules を使えない', raw.threadTs);
    }
    return;
  }

  switch (result.kind) {
    case 'drop':
      logger.debug(`受信を破棄 reason=${result.reason}`);
      return;

    case 'verdict':
      // gate 通過後に期限が切れた場合は Claude に送っていないので、リアクションも付けない
      if (!(await relay.answerByText(result.verdict, raw.user ?? ''))) return;
      if (raw.channel && raw.ts) {
        const reaction = result.verdict.behavior === 'allow' ? REACTION.ALLOW : REACTION.DENY;
        await bridge.addReaction(raw.channel, raw.ts, reaction);
      }
      return;

    case 'deliver':
      if (raw.channel && raw.threadTs) relay.rememberThread(raw.channel, raw.threadTs);
      await server.pushMessage(result.content, result.meta);
      if (raw.channel && raw.threadTs) watchdog?.delivered({ channel: raw.channel, threadTs: raw.threadTs });
      if (raw.channel && raw.ts) await bridge.addReaction(raw.channel, raw.ts, REACTION.SEEN);
      return;
  }
}

/** permission request のボタン（Allow / Deny / See more）が押されたとき */
export async function handleAction(wiring: Wiring, parsed: ActionParse, ctx: ActionContext): Promise<void> {
  if (!parsed.ok) {
    wiring.logger.warn(`block_actions を無視 reason=${parsed.reason}`);
    return;
  }

  const pressed = ctx.channelId && ctx.messageTs ? { channel: ctx.channelId, ts: ctx.messageTs } : undefined;
  // ボタンのメッセージが属するスレッド（スレッド外ならボタンのメッセージ自身を起点にする）
  const threadTs = ctx.threadTs ?? ctx.messageTs;
  const byUserId = ctx.userId ?? '';

  switch (parsed.kind) {
    case 'verdict':
      await wiring.relay.answerByButton(parsed.verdict, byUserId, pressed);
      return;

    case 'see_more':
      await sendFullPreview(wiring, parsed.requestId, ctx);
      return;

    case 'allow_always': {
      // 回答すると保留から消えるので、先に中身を控えておく
      const req = wiring.relay.lookup(parsed.requestId);
      await wiring.relay.answerByButton({ requestId: parsed.requestId, behavior: 'allow' }, byUserId, pressed);
      if (req && ctx.channelId && threadTs && wiring.rules) await wiring.rules.propose(req, ctx.channelId, threadTs);
      return;
    }

    case 'screen_show':
      if (ctx.channelId && threadTs && wiring.screen) await wiring.screen.show(ctx.channelId, threadTs);
      return;

    case 'screen_pick':
      if (ctx.channelId && threadTs && wiring.screen) {
        await wiring.screen.pick(parsed.snapshotId, parsed.index, { channel: ctx.channelId, ts: ctx.messageTs, threadTs }, byUserId);
      }
      return;

    case 'rule_confirm':
      if (ctx.channelId && threadTs && wiring.rules) {
        await wiring.rules.confirm(parsed.proposalId, parsed.accept, { channel: ctx.channelId, ts: ctx.messageTs, threadTs }, byUserId);
      }
      return;

    case 'rule_remove':
      if (ctx.channelId && threadTs && wiring.rules) {
        await wiring.rules.remove(parsed.rule, { channel: ctx.channelId, ts: ctx.messageTs, threadTs }, byUserId);
      }
      return;
  }
}

/**
 * input_preview をコードブロックで包む。中身の行頭の ``` はゼロ幅スペースを前置して、
 * フェンスの開閉と誤認されない（分割送信時の開き直しも崩れない）ようにする。
 */
export function fencePreview(preview: string): string {
  return '```\n' + preview.replace(/^```/gm, '\u200b```') + '\n```';
}

/**
 * See more: ボタンのメッセージでは省略した input_preview の全文をスレッドに送る。
 * 不可視文字（双方向制御・ゼロ幅・BOM）は revealInvisible で `\u{XXXX}` に置き換えてから送る。
 * 長いときは postText がコードブロックを保ったまま複数メッセージに分ける。期限切れならその旨だけ送る。
 * 送り先はボタンのメッセージが属するスレッド（スレッド外ならボタンのメッセージ自身を起点にする）。
 */
async function sendFullPreview({ bridge, relay, logger }: Wiring, requestId: string, ctx: ActionContext): Promise<void> {
  if (!ctx.channelId || !ctx.messageTs) return;

  const threadTs = ctx.threadTs ?? ctx.messageTs;
  const req = relay.lookup(requestId);
  try {
    if (req) {
      await bridge.postText(ctx.channelId, fencePreview(revealInvisible(req.input_preview)), threadTs);
    } else {
      await bridge.postText(ctx.channelId, `⌛ permission request ${requestId} は既に期限切れ`, threadTs);
    }
  } catch (e) {
    logger.warn('see_more の送信に失敗', e);
  }
}

// --- 起動 ---------------------------------------------------------------------

export interface RunningApp {
  /** 後片付け（lock.release → 無応答の見張りを解く → 保留中の permission request を deny → ホームを停止中にする（通常モードのみ） → bridge.stop → server.close の順。2 回目以降の呼び出しは 1 回目と同じ Promise を返す） */
  stop: () => Promise<void>;
}

export interface BridgeAppOptions {
  /** init() 済みの SlackBridge */
  bridge: AppBridge;
  logger: Logger;
  /** MCP のトランスポート。省略時は stdio */
  transport?: Transport | undefined;
  /** stop() の最初に release する（後片付けが固まってもロックを残さないため） */
  lock?: Pick<InstanceLock, 'release'> | undefined;
  /**
   * bridge.start() より前に、後片付けの関数を渡して呼ぶ。終了処理（stdin の終了・シグナル）の登録に使い、
   * Socket Mode の接続待ちの最中に Claude Code が終了しても後片付けされるようにする。
   */
  onCleanupReady?: ((stop: () => Promise<void>) => void) | undefined;
  /**
   * Claude に渡したメッセージへの応答（reply / react / edit_message / permission_request）を待つ時間（ミリ秒）。
   * 過ぎたらそのスレッドに無応答の警告を投稿する。0 以下なら見張らない。省略時は見張らない
   */
  replyTimeoutMs?: number | undefined;
  /** ターミナル画面の読み取り・選択キーの送信。省略時は !screen と画面のボタンが使えない */
  console?: ConsoleAccess | undefined;
  /** Slack から追加した許可ルールの保存先（状態ディレクトリの allow-extra.json）。省略時は「今後も許可」で追加しない */
  allowExtraFile?: string | undefined;
  /** 追加の前に照合する deny を読む設定ファイル（channel-settings.json と作業フォルダーの .claude/settings*.json） */
  denyFiles?: string[] | undefined;
  /**
   * アプリのホームタブに状態を出す。起動時に users 全員のホームを「稼働中」にし、終了時に「停止中」へ書き換え、
   * ホームが開かれたら最新の状態で出し直す。省略時はホームを更新しない
   */
  home?: { users: string[]; workDir: string; channelCount: number; botUserId?: string | undefined } | undefined;
}

/**
 * 通常モード: Slack と Claude Code（MCP）をつないで中継を始める。
 * MCP の接続か Socket Mode の開始に失敗したら、後片付け（lock.release → relay.denyAll → bridge.stop → server.close）をしてから投げ直す。
 */
export async function startBridgeApp(opts: BridgeAppOptions): Promise<RunningApp> {
  const { bridge, logger } = opts;

  const watchdog = new ResponseWatchdog({
    timeoutMs: opts.replyTimeoutMs ?? 0,
    logger,
    notify: async ({ channel, threadTs }, minutes) => {
      const text = buildNoResponseText(minutes);
      const blocks = [
        { type: 'section', text: { type: 'plain_text', text } },
        ...(opts.console ? [{ type: 'actions', elements: [screenShowButton()] }] : []),
      ];
      await bridge.postBlocks(channel, text, blocks, threadTs);
    },
  });
  const screen = new ScreenRelay({ console: opts.console, slack: bridge, logger });
  const ruleStore = opts.allowExtraFile ? new AllowRuleStore(opts.allowExtraFile) : undefined;
  const rules = ruleStore
    ? new RuleRelay({
        store: ruleStore,
        loadDeny: () => (opts.denyFiles ?? []).flatMap((f) => readDeny(f)),
        slack: bridge,
        logger,
      })
    : undefined;

  // server と relay は互いを参照する。relay を使うのは接続後なので、宣言順はこれでよい
  const server: ChannelServer = new ChannelServer({
    logger,
    ...createToolHandlers(bridge, logger, () => watchdog.activity()),
    onPermissionRequest: (req) => {
      watchdog.activity();
      return relay.request(req);
    },
  });
  const relay: PermissionRelay = new PermissionRelay(bridge, server, logger);
  const wiring: Wiring = { bridge, server, relay, logger, watchdog, screen, rules };

  // --- ホームタブ -------------------------------------------------------------
  const startedAt = new Date();
  const homeView = (running: boolean, since: Date): unknown =>
    buildHomeView({
      running,
      since,
      workDir: opts.home?.workDir ?? '',
      channelCount: opts.home?.channelCount ?? 0,
      botUserId: opts.home?.botUserId,
      ruleCount: ruleStore?.list().length,
      replyTimeoutMin: Math.round((opts.replyTimeoutMs ?? 0) / 60000),
      now: new Date(),
    });
  const publishHomeAll = async (running: boolean, since: Date): Promise<void> => {
    if (!opts.home || !bridge.publishHome) return;
    for (const user of opts.home.users) await bridge.publishHome(user, homeView(running, since));
  };
  const onHomeOpened = async (user: string, allowed: boolean): Promise<void> => {
    if (!opts.home || !bridge.publishHome) return;
    await bridge.publishHome(user, allowed ? homeView(true, startedAt) : buildForbiddenHomeView());
  };

  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopped ??= (async () => {
      opts.lock?.release();
      watchdog.stop();
      try {
        // Slack の書き換えと Claude への通知が届くよう、切断より前に行う（denyAll・publishHome は投げない）
        await relay.denyAll('ブリッジ終了');
        await publishHomeAll(false, new Date());
        await bridge.stop();
      } finally {
        await server.close();
      }
    })());
  opts.onCleanupReady?.(stop);

  try {
    if (opts.transport) await server.connect(opts.transport);
    else await server.connectStdio();
    await bridge.start({
      onMessage: (result, raw) => handleMessage(wiring, result, raw),
      onAction: (parsed, ctx) => handleAction(wiring, parsed, ctx),
      isKnownRequest: (id) => relay.lookup(id) !== undefined,
      onHomeOpened,
    });
  } catch (e) {
    await stop().catch((err: unknown) => logger.error('起動失敗後の後片付けで例外', err));
    throw e;
  }
  logger.info('Slack ブリッジ稼働中');
  await publishHomeAll(true, startedAt);

  return { stop };
}

export interface DegradedAppOptions {
  logger: Logger;
  /** MCP のトランスポート。省略時は stdio */
  transport?: Transport | undefined;
}

/** 縮退モード: MCP サーバーだけ起動し、ツールはすべてエラーを返す */
export async function startDegradedApp(opts: DegradedAppOptions): Promise<RunningApp> {
  const server = new ChannelServer(createDegradedDeps(opts.logger));
  if (opts.transport) await server.connect(opts.transport);
  else await server.connectStdio();

  return { stop: () => server.close() };
}
