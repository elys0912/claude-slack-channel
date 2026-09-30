// Slack と Claude Code（MCP）をつなぐ配線。import 時の副作用は持たない（プロセス周りは main.ts）。
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { errMessage } from './errors.js';
import type { Logger } from './log.js';
import type { InstanceLock } from './lock.js';
import type { SlackBridge, ActionContext, InboundRef } from './slack.js';
import { ChannelServer } from './mcp.js';
import type { McpDeps } from './mcp.js';
import { PermissionRelay } from './permission-relay.js';
import { preformattedBlock } from './permission.js';
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

/** DM で届いたメッセージ。`yes xxxxx` / `no xxxxx` なら許可の回答、それ以外は Claude へ中継する */
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
      await relay.answerByText(result.verdict, raw.user ?? '');
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

// --- 起動 ---------------------------------------------------------------------

export interface RunningApp {
  /** 後片付け（bridge.stop → server.close → lock.release の順） */
  stop: () => Promise<void>;
}

export interface BridgeAppOptions {
  /** init() 済みの SlackBridge */
  bridge: AppBridge;
  logger: Logger;
  /** MCP のトランスポート。省略時は stdio */
  transport?: Transport | undefined;
  /** stop() の最後に release する */
  lock?: Pick<InstanceLock, 'release'> | undefined;
}

/** 通常モード: Slack と Claude Code（MCP）をつないで中継を始める */
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

  if (opts.transport) await server.connect(opts.transport);
  else await server.connectStdio();
  await bridge.start({
    onMessage: (result, raw) => handleMessage(wiring, result, raw),
    onAction: (parsed, ctx) => handleAction(wiring, parsed, ctx),
  });
  logger.info('Slack ブリッジ稼働中');

  return {
    stop: async () => {
      await bridge.stop();
      await server.close();
      opts.lock?.release();
    },
  };
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
