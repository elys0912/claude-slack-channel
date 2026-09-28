// Slack との接続（Socket Mode の受信 + Web API の送信）をまとめる。
// MCP のことは知らない。MCP との結合は main.ts の役目。
import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import type { ParsedAccess } from './config.js';
import type { Logger as SlackSdkLogger } from '@slack/logger';
import type { Logger } from './log.js';
import { toSlackLogger } from './log.js';
import { EventDedupe, gate } from './gate.js';
import type { GateResult, InboundMessage } from './gate.js';
import { parseBlockAction } from './permission.js';
import type { ActionParse } from './permission.js';
import { chunkText } from './chunk.js';
import { escapeMrkdwn, neutralizeBroadcasts } from './format.js';

// markdown_text は Slack 側の上限が 12000。余裕をみて 11000 で切る。
const MARKDOWN_LIMIT = 11000;
// text は 40000 まで入るが、実用上は 4000 前後で分割されるので 3900 で切る。
const TEXT_LIMIT = 3900;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

/** テストで差し替えられるよう、実際に使う Web API のメソッドだけを型にする */
export interface SlackWebApiLike {
  auth: {
    test(args?: Record<string, unknown>): Promise<{
      ok?: boolean;
      team_id?: string;
      enterprise_id?: string;
      user_id?: string;
      bot_id?: string;
    }>;
  };
  conversations: {
    open(args: Record<string, unknown>): Promise<{ ok?: boolean; channel?: { id?: string } }>;
  };
  chat: {
    postMessage(args: Record<string, unknown>): Promise<{ ok?: boolean; ts?: string }>;
    update(args: Record<string, unknown>): Promise<{ ok?: boolean; ts?: string }>;
  };
  reactions: {
    add(args: Record<string, unknown>): Promise<{ ok?: boolean }>;
  };
}

/** テストで差し替えられるよう、実際に使う Socket Mode のメソッドだけを型にする */
export interface SocketClientLike {
  on(event: string, listener: (...args: never[]) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

export interface SlackDeps {
  botToken: string;
  appToken: string;
  access: ParsedAccess;
  logger: Logger;
  /** テスト用の差し替え口（省略時は実際の WebClient を作る） */
  web?: SlackWebApiLike;
  /** テスト用の差し替え口（省略時は実際の SocketModeClient を作る） */
  socket?: SocketClientLike;
}

export interface SlackBridgeEvents {
  onMessage: (
    r: GateResult,
    raw: { channel?: string; ts?: string; threadTs?: string; user?: string }
  ) => void | Promise<void>;
  onAction: (
    parsed: ActionParse,
    ctx: { userId?: string; channelId?: string; messageTs?: string; value?: string }
  ) => void | Promise<void>;
}

export interface SlackInitResult {
  botUserId: string;
  teamId: string;
  dmChannels: Map<string, string>;
}

// --- Slack API エラーの判定 ------------------------------------------------

function errorCodeOf(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const e = err as { data?: unknown; message?: unknown };
  if (typeof e.data === 'object' && e.data !== null) {
    const code = (e.data as { error?: unknown }).error;
    if (typeof code === 'string') return code;
  }
  if (typeof e.message === 'string') return e.message;
  return '';
}

/**
 * Slack SDK に渡すロガー。setName を無視して、代わりに行頭へ範囲名を付ける。
 * （Logger はプロセスで 1 つを共有しているので、SDK に名前を書き換えさせない）
 */
function sdkLogger(logger: Logger, scope: string): SlackSdkLogger {
  const base = toSlackLogger(logger);
  const tag = `[${scope}]`;
  return {
    ...base,
    debug: (...m: unknown[]) => logger.debug(tag, ...m),
    info: (...m: unknown[]) => logger.info(tag, ...m),
    warn: (...m: unknown[]) => logger.warn(tag, ...m),
    error: (...m: unknown[]) => logger.error(tag, ...m),
    setName: () => undefined,
  };
}

const MARKDOWN_REJECT_RE =
  /invalid_arguments?|unknown_argument|msg_too_long|invalid_form_data|invalid_markdown|invalid_blocks/i;

/** markdown_text が受け付けられなかった種類のエラーか */
export function isMarkdownRejection(err: unknown): boolean {
  return MARKDOWN_REJECT_RE.test(errorCodeOf(err));
}

// --- 受信イベントの詰め替え -------------------------------------------------

type RawEvent = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function obj(v: unknown): RawEvent | undefined {
  return typeof v === 'object' && v !== null ? (v as RawEvent) : undefined;
}

/** events_api の payload を gate 用の InboundMessage に詰め替える */
export function toInboundMessage(body: RawEvent): InboundMessage {
  const ev = obj(body.event) ?? {};
  const rawFiles = Array.isArray(ev.files) ? ev.files : undefined;
  const files = rawFiles?.map((f) => {
    const o = obj(f) ?? {};
    const size = typeof o.size === 'number' ? o.size : undefined;
    return { name: str(o.name), mimetype: str(o.mimetype), size };
  });

  return {
    teamId: str(body.team_id),
    eventId: str(body.event_id),
    channelType: str(ev.channel_type),
    channel: str(ev.channel),
    user: str(ev.user),
    // Slack Connect 等で送信者の所属が違う場合に user_team が入る
    userTeam: str(ev.user_team) ?? str(ev.team),
    botId: str(ev.bot_id),
    subtype: str(ev.subtype),
    text: str(ev.text),
    ts: str(ev.ts),
    threadTs: str(ev.thread_ts),
    files,
  };
}

// --- 本体 -------------------------------------------------------------------

export class SlackBridge {
  private readonly access: ParsedAccess;
  private readonly logger: Logger;
  private readonly web: SlackWebApiLike;
  private readonly appToken: string;
  private readonly injectedSocket: SocketClientLike | undefined;
  // SocketModeClient はコンストラクタの時点で undici のハンドルを掴むので、
  // init() が失敗しただけで終了する場合に備えて start() まで作らない。
  private socketClient: SocketClientLike | undefined;
  private readonly dedupe = new EventDedupe();
  private readonly dmChannels = new Map<string, string>();
  private readonly dmChannelIds = new Set<string>();

  private botUserId: string | undefined;
  private handlers: SlackBridgeEvents | undefined;
  private listenersBound = false;
  private connected = false;
  private stopping = false;
  private backoffMs = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: SlackDeps) {
    this.access = deps.access;
    this.logger = deps.logger;
    this.appToken = deps.appToken;
    this.injectedSocket = deps.socket;
    this.web =
      deps.web ??
      (new WebClient(deps.botToken, {
        logger: sdkLogger(deps.logger, 'slack-web'),
        // 長時間ブロックしないよう、リトライは控えめにする
        retryConfig: { retries: 2, factor: 2, minTimeout: 500, maxTimeout: 5000 },
        timeout: 15000,
      }) as unknown as SlackWebApiLike);
  }

  private socket(): SocketClientLike {
    if (!this.socketClient) {
      this.socketClient =
        this.injectedSocket ??
        (new SocketModeClient({
          appToken: this.appToken,
          logger: sdkLogger(this.logger, 'slack-socket'),
          autoReconnectEnabled: true,
          clientOptions: {
            retryConfig: { retries: 2, factor: 2, minTimeout: 500, maxTimeout: 5000 },
          },
        }) as unknown as SocketClientLike);
    }
    return this.socketClient;
  }

  get allowedDmChannels(): ReadonlySet<string> {
    return this.dmChannelIds;
  }

  // --- 初期化 ---------------------------------------------------------------

  async init(): Promise<SlackInitResult> {
    const auth = await this.web.auth.test();
    const teamId = auth.team_id ?? '';
    const enterpriseId = auth.enterprise_id ?? '';
    if (teamId !== this.access.teamId && enterpriseId !== this.access.teamId) {
      throw new Error(
        `auth.test の team_id が access.json と一致しない（設定=${this.access.teamId}）`
      );
    }
    const botUserId = auth.user_id;
    if (!botUserId) {
      throw new Error('auth.test が user_id を返さなかった');
    }
    this.botUserId = botUserId;

    for (const userId of this.access.allowFrom) {
      try {
        const res = await this.web.conversations.open({ users: userId });
        const channelId = res.channel?.id;
        if (!channelId) {
          this.logger.warn(`conversations.open が channel.id を返さなかった user=${userId}`);
          continue;
        }
        this.dmChannels.set(userId, channelId);
        this.dmChannelIds.add(channelId);
      } catch (e) {
        this.logger.error(`conversations.open に失敗 user=${userId}`, e);
      }
    }

    if (this.dmChannels.size === 0) {
      throw new Error('許可ユーザーの DM チャンネルを 1 件も開けなかった');
    }

    return { botUserId, teamId: teamId || enterpriseId, dmChannels: new Map(this.dmChannels) };
  }

  // --- 起動・停止 -----------------------------------------------------------

  async start(handlers: SlackBridgeEvents): Promise<void> {
    this.handlers = handlers;
    this.stopping = false;
    if (!this.listenersBound) {
      this.bindListeners();
      this.listenersBound = true;
    }
    await this.socket().start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (!this.socketClient) return;
    try {
      await this.socketClient.disconnect();
    } catch (e) {
      this.logger.warn('SocketModeClient の切断に失敗', e);
    }
  }

  private bindListeners(): void {
    const on = (event: string, fn: (arg: RawEvent) => void): void => {
      this.socket().on(event, ((arg: RawEvent) => fn(arg ?? {})) as (...a: never[]) => void);
    };

    on('connecting', () => this.logger.info('socket: connecting'));
    on('connected', () => {
      this.connected = true;
      this.backoffMs = RECONNECT_BASE_MS;
      this.logger.info('socket: connected');
    });
    on('reconnecting', () => this.logger.info('socket: reconnecting'));
    on('disconnecting', () => this.logger.info('socket: disconnecting'));
    on('disconnected', () => {
      this.connected = false;
      this.logger.warn('socket: disconnected');
      this.scheduleReconnect();
    });

    on('slack_event', (arg) => {
      void this.handleSlackEvent(arg);
    });
    on('interactive', (arg) => {
      void this.handleInteractive(arg);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopping || this.connected) return;
      this.logger.warn(`socket: 再接続を試みる（次の待ち ${this.backoffMs}ms）`);
      // SocketModeClient の自動再接続と競合しても start() は冪等に扱われる
      void Promise.resolve(this.socket().start()).catch((e: unknown) => {
        this.logger.error('socket: 再接続に失敗', e);
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  // --- 受信ハンドラ ---------------------------------------------------------

  private async ackFirst(arg: RawEvent): Promise<void> {
    const ack = arg.ack;
    if (typeof ack !== 'function') return;
    try {
      await (ack as () => Promise<void> | void)();
    } catch (e) {
      this.logger.warn('ack に失敗', e);
    }
  }

  private async handleSlackEvent(arg: RawEvent): Promise<void> {
    try {
      if (str(arg.type) !== 'events_api') return;
      // 何よりも先に ack する
      await this.ackFirst(arg);

      const body = obj(arg.body) ?? {};
      const ev = obj(body.event) ?? {};
      if (str(ev.type) !== 'message') return;

      const msg = toInboundMessage(body);
      const result = gate(msg, this.access, this.botUserId, this.dedupe);
      await this.handlers?.onMessage(result, {
        channel: msg.channel,
        ts: msg.ts,
        threadTs: msg.threadTs ?? msg.ts,
        user: msg.user,
      });
    } catch (e) {
      this.logger.error('slack_event の処理で例外', e);
    }
  }

  private async handleInteractive(arg: RawEvent): Promise<void> {
    try {
      await this.ackFirst(arg);

      const body = obj(arg.body) ?? {};
      const actions = Array.isArray(body.actions) ? body.actions : [];
      const action = obj(actions[0]) ?? {};
      const channelId = str(obj(body.channel)?.id);
      const userId = str(obj(body.user)?.id);
      const value = str(action.value);
      const messageTs = str(obj(body.container)?.message_ts) ?? str(obj(body.message)?.ts);

      const parsed = parseBlockAction(
        {
          type: str(body.type),
          teamId: str(obj(body.team)?.id),
          userId,
          channelId,
          actionId: str(action.action_id),
          value,
        },
        this.access,
        this.dmChannelIds
      );

      await this.handlers?.onAction(parsed, { userId, channelId, messageTs, value });
    } catch (e) {
      this.logger.error('interactive の処理で例外', e);
    }
  }

  // --- 送信 -----------------------------------------------------------------

  private assertAllowed(channel: string): void {
    if (!this.dmChannelIds.has(channel)) {
      throw new Error('許可されていない送信先チャンネル');
    }
  }

  async postText(channel: string, text: string, threadTs?: string): Promise<{ ts: string[] }> {
    this.assertAllowed(channel);
    const safe = neutralizeBroadcasts(text);
    const tsList: string[] = [];
    if (safe === '') return { ts: tsList };

    const blocksOfMarkdown = chunkText(safe, MARKDOWN_LIMIT);
    let useMarkdown = true;

    for (const piece of blocksOfMarkdown) {
      if (useMarkdown) {
        try {
          const res = await this.web.chat.postMessage({
            channel,
            markdown_text: piece,
            ...(threadTs ? { thread_ts: threadTs } : {}),
          });
          if (res.ts) tsList.push(res.ts);
          continue;
        } catch (e) {
          if (!isMarkdownRejection(e)) throw e;
          // このチャンク以降は text にフォールバックする
          this.logger.warn('markdown_text が拒否されたので text に切り替える', e);
          useMarkdown = false;
        }
      }
      // text は上限が小さいので、さらに分割してから送る
      for (const sub of chunkText(piece, TEXT_LIMIT)) {
        const res = await this.web.chat.postMessage({
          channel,
          text: escapeMrkdwn(sub),
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
        if (res.ts) tsList.push(res.ts);
      }
    }

    return { ts: tsList };
  }

  async postBlocks(channel: string, text: string, blocks: unknown[], threadTs?: string): Promise<{ ts: string }> {
    this.assertAllowed(channel);
    const res = await this.web.chat.postMessage({
      channel,
      text: neutralizeBroadcasts(text),
      blocks,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return { ts: res.ts ?? '' };
  }

  /** ブロックを外してテキストだけに書き換える（edit_message ツール用） */
  async updateText(channel: string, ts: string, text: string): Promise<void> {
    this.assertAllowed(channel);
    await this.web.chat.update({
      channel,
      ts,
      text: escapeMrkdwn(neutralizeBroadcasts(text)),
      blocks: [],
    });
  }

  async updateBlocks(channel: string, ts: string, text: string, blocks: unknown[]): Promise<void> {
    this.assertAllowed(channel);
    await this.web.chat.update({
      channel,
      ts,
      text: neutralizeBroadcasts(text),
      blocks,
    });
  }

  /** リアクション付与。already_reacted 等で失敗しても投げない */
  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    this.assertAllowed(channel);
    try {
      await this.web.reactions.add({ channel, timestamp: ts, name });
    } catch (e) {
      this.logger.warn(`reactions.add に失敗 name=${name}`, e);
    }
  }

  /**
   * 許可ユーザー全員の DM に送る。threadFor が thread_ts を返したチャンネルでは
   * そのスレッドに、返さなかったチャンネルではトップレベルに投稿する。
   */
  async postToAll(
    text: string,
    blocks?: unknown[],
    threadFor?: (channel: string) => string | undefined
  ): Promise<{ channel: string; ts: string }[]> {
    const out: { channel: string; ts: string }[] = [];
    for (const channel of this.dmChannels.values()) {
      const threadTs = threadFor?.(channel);
      try {
        if (blocks) {
          const res = await this.postBlocks(channel, text, blocks, threadTs);
          out.push({ channel, ts: res.ts });
        } else {
          const res = await this.postText(channel, text, threadTs);
          const first = res.ts[0];
          out.push({ channel, ts: first ?? '' });
        }
      } catch (e) {
        this.logger.error(`DM への送信に失敗 channel=${channel}`, e);
      }
    }
    return out;
  }
}
