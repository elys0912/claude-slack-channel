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
>;

/** 受信処理が使う MCP サーバー側の操作 */
export type AppServer = Pick<ChannelServer, 'pushMessage'>;

/** 受信処理が使う permission relay の操作 */
export type AppRelay = Pick<PermissionRelay, 'answerByText' | 'answerByButton' | 'rememberThread' | 'lookup'>;

export interface Wiring {
  bridge: AppBridge;
  server: AppServer;
  relay: AppRelay;
  logger: Logger;
}

// --- Claude → Slack（MCP ツールの実体） ----------------------------------------

export type ToolHandlers = Pick<McpDeps, 'onReply' | 'onReact' | 'onEdit'>;

/** reply / react / edit_message の実体。失敗しても投げず、Claude が読めるエラー文を返す */
export function createToolHandlers(bridge: ToolBridge, logger: Logger): ToolHandlers {
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

/** DM で届いたメッセージ。保留中の ID への `yes xxxxx` / `no xxxxx` なら許可の回答、それ以外は Claude へ中継する */
export async function handleMessage(
  { bridge, server, relay, logger }: Wiring,
  result: GateResult,
  raw: InboundRef
): Promise<void> {
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

  if (parsed.kind === 'verdict') {
    const pressed = ctx.channelId && ctx.messageTs ? { channel: ctx.channelId, ts: ctx.messageTs } : undefined;
    await wiring.relay.answerByButton(parsed.verdict, ctx.userId ?? '', pressed);
    return;
  }

  await sendFullPreview(wiring, parsed.requestId, ctx);
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
  /** 後片付け（lock.release → bridge.stop → server.close の順。2 回目以降の呼び出しは 1 回目と同じ Promise を返す） */
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
}

/**
 * 通常モード: Slack と Claude Code（MCP）をつないで中継を始める。
 * MCP の接続か Socket Mode の開始に失敗したら、後片付け（lock.release → bridge.stop → server.close）をしてから投げ直す。
 */
export async function startBridgeApp(opts: BridgeAppOptions): Promise<RunningApp> {
  const { bridge, logger } = opts;

  // server と relay は互いを参照する。relay を使うのは接続後なので、宣言順はこれでよい
  const server: ChannelServer = new ChannelServer({
    logger,
    ...createToolHandlers(bridge, logger),
    onPermissionRequest: (req) => relay.request(req),
  });
  const relay: PermissionRelay = new PermissionRelay(bridge, server, logger);
  const wiring: Wiring = { bridge, server, relay, logger };

  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopped ??= (async () => {
      opts.lock?.release();
      try {
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
    });
  } catch (e) {
    await stop().catch((err: unknown) => logger.error('起動失敗後の後片付けで例外', err));
    throw e;
  }
  logger.info('Slack ブリッジ稼働中');

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
