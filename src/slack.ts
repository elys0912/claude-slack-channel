// Slack との接続（Socket Mode の受信 + Web API の送信）をまとめる。
// MCP のことは知らない。MCP との結合は app.ts の役目。
import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import type { ParsedAccess } from './config.js';
import type { Logger } from './log.js';
import { toSlackLogger } from './log.js';
import { EventDedupe, gate } from './gate.js';
import type { GateResult, InboundMessage } from './gate.js';
import { parseBlockAction } from './permission.js';
import type { ActionParse, BlockActionInput } from './permission.js';
import { chunkText } from './chunk.js';
import { escapeMrkdwn, neutralizeBroadcasts } from './format.js';
import { errMessage, slackErrorCode } from './errors.js';

// markdown_text は Slack 側の上限が 12000。余裕をみて 11000 で切る。
const MARKDOWN_LIMIT = 11000;
// text は 40000 まで入るが、実用上は 4000 前後で分割されるので 3900 で切る。
const TEXT_LIMIT = 3900;

/** 覚えておくチャンネルのスレッドの上限 */
const ACTIVE_THREAD_CAPACITY = 1000;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

// 長時間ブロックしないよう、Web API のリトライは控えめにする
// （Socket Mode 側の apps.connections.open は SDK の既定に任せる）
const RETRY_CONFIG = { retries: 2, factor: 2, minTimeout: 500, maxTimeout: 5000 };

// 送信内容の URL を Slack にプレビュー展開させない（展開のための外部アクセスと、中身の意図しない表示を防ぐ）
const NO_UNFURL = { unfurl_links: false, unfurl_media: false } as const;

/** threadTs があるときだけ chat.* に渡す thread_ts を作る */
function threadParam(threadTs: string | undefined): { thread_ts?: string } {
  return threadTs ? { thread_ts: threadTs } : {};
}

/** テストで差し替えられるよう、実際に使う Web API のメソッドだけを型にする */
export interface SlackWebApiLike {
  auth: {
    test(args?: Record<string, unknown>): Promise<{
      ok?: boolean;
      team_id?: string;
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
  views: {
    publish(args: Record<string, unknown>): Promise<{ ok?: boolean }>;
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

/** 受信メッセージの位置情報（リアクションやスレッド返信の宛先に使う） */
export interface InboundRef {
  channel?: string | undefined;
  ts?: string | undefined;
  /** スレッド外のメッセージなら ts と同じ（そのメッセージを起点にスレッドを作る） */
  threadTs?: string | undefined;
  user?: string | undefined;
}

/** ボタンが押されたメッセージと押した人 */
export interface ActionContext {
  userId?: string | undefined;
  channelId?: string | undefined;
  messageTs?: string | undefined;
  /** ボタンのメッセージがスレッド内にあるときのスレッドの親 ts */
  threadTs?: string | undefined;
}

export interface SlackBridgeEvents {
  onMessage: (r: GateResult, raw: InboundRef) => void | Promise<void>;
  onAction: (parsed: ActionParse, ctx: ActionContext) => void | Promise<void>;
  /** 保留中の permission request か（gate に渡す。省略時は `yes xxxxx` の形なら常に verdict） */
  isKnownRequest?: ((requestId: string) => boolean) | undefined;
  /** アプリのホームタブが開かれた（team は確認済み。allowed は allowFrom に入っているか） */
  onHomeOpened?: ((userId: string, allowed: boolean) => void | Promise<void>) | undefined;
}

export interface SlackInitResult {
  botUserId: string;
  teamId: string;
  /** 開けた DM チャンネルの件数 */
  dmChannelCount: number;
}

const MARKDOWN_REJECT_RE =
  /invalid_arguments?|unknown_argument|msg_too_long|invalid_form_data|invalid_markdown|invalid_blocks/i;

/** markdown_text が受け付けられなかった種類のエラーか（コードが無ければメッセージで判定） */
export function isMarkdownRejection(err: unknown): boolean {
  const message = (err as { message?: unknown } | null)?.message;
  const code = slackErrorCode(err) ?? (typeof message === 'string' ? message : '');
  return MARKDOWN_REJECT_RE.test(code);
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

/**
 * block_actions の payload から、parseBlockAction の入力と、ボタンが押されたメッセージの位置情報を取り出す。
 * actions が配列でなければ action 無しとして扱う。messageTs は container.message_ts を優先し、無ければ message.ts。
 * threadTs は container.thread_ts を優先し、無ければ message.thread_ts。
 */
export function toBlockActionInput(body: RawEvent): { input: BlockActionInput; ctx: ActionContext } {
  const actions = Array.isArray(body.actions) ? body.actions : [];
  const action = obj(actions[0]) ?? {};
  const channelId = str(obj(body.channel)?.id);
  const userId = str(obj(body.user)?.id);
  const value = str(action.value);
  const messageTs = str(obj(body.container)?.message_ts) ?? str(obj(body.message)?.ts);
  const threadTs = str(obj(body.container)?.thread_ts) ?? str(obj(body.message)?.thread_ts);

  return {
    input: {
      type: str(body.type),
      teamId: str(obj(body.team)?.id),
      userId,
      channelId,
      actionId: str(action.action_id),
      value,
    },
    ctx: { userId, channelId, messageTs, threadTs },
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
  /** 送信やボタン操作を受け付けるチャンネル（許可ユーザーの DM + access.channels） */
  private readonly allowedChannelIds = new Set<string>();
  /** access.channels のチャンネルで、ボットが関わっているスレッド（`channel:threadTs`）。古いものから忘れる */
  private readonly activeThreads = new Map<string, true>();

  private botUserId: string | undefined;
  private handlers: SlackBridgeEvents | undefined;
  private listenersBound = false;
  private connected = false;
  private stopping = false;
  /** start() の実行中。この間の disconnected は start() の失敗として扱うので、別途再接続を予約しない */
  private connecting = false;
  private backoffMs = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** 受信イベントの処理の列（末尾） */
  private inbound: Promise<void> = Promise.resolve();

  constructor(deps: SlackDeps) {
    this.access = deps.access;
    this.logger = deps.logger;
    this.appToken = deps.appToken;
    this.injectedSocket = deps.socket;
    for (const channel of deps.access.channels ?? []) this.allowedChannelIds.add(channel);
    this.web =
      deps.web ??
      (new WebClient(deps.botToken, {
        logger: toSlackLogger(deps.logger, 'slack-web'),
        retryConfig: RETRY_CONFIG,
        timeout: 15000,
      }) as unknown as SlackWebApiLike);
  }

  private socket(): SocketClientLike {
    if (!this.socketClient) {
      this.socketClient =
        this.injectedSocket ??
        (new SocketModeClient({
          appToken: this.appToken,
          logger: toSlackLogger(this.logger, 'slack-socket'),
          // 再接続はこちらで行う（SDK の自動再接続と二重に張らないため）
          autoReconnectEnabled: false,
        }) as unknown as SocketClientLike);
    }
    return this.socketClient;
  }

  /** 送信先として分かっている許可ユーザーの DM チャンネル（access.channels は含まない） */
  get allowedDmChannels(): ReadonlySet<string> {
    return new Set(this.dmChannels.values());
  }

  // --- 初期化 ---------------------------------------------------------------

  /**
   * 接続前の確認。auth.test の team_id が access.teamId と一致するかを確かめ、bot の user ID を覚える。
   * 続けて allowFrom の各ユーザーと conversations.open で DM を開き、送信先として登録する
   * （開けなかったユーザーはログに残して飛ばし、後で DM を受信した時点で登録する）。
   * team_id の不一致、user_id が返らない、DM を 1 件も開けないときは投げる。
   */
  async init(): Promise<SlackInitResult> {
    const auth = await this.web.auth.test();
    const teamId = auth.team_id ?? '';
    if (teamId !== this.access.teamId) {
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
        this.allowedChannelIds.add(channelId);
      } catch (e) {
        this.logger.error(`conversations.open に失敗 user=${userId}`, e);
      }
    }

    if (this.dmChannels.size === 0) {
      throw new Error('許可ユーザーの DM チャンネルを 1 件も開けなかった');
    }

    return { botUserId, teamId, dmChannelCount: this.dmChannels.size };
  }

  // --- 起動・停止 -----------------------------------------------------------

  async start(handlers: SlackBridgeEvents): Promise<void> {
    this.handlers = handlers;
    this.stopping = false;
    if (!this.listenersBound) {
      this.bindListeners();
      this.listenersBound = true;
    }
    this.connecting = true;
    try {
      await this.socket().start();
    } finally {
      this.connecting = false;
    }
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
      if (!this.connecting) this.scheduleReconnect();
    });

    on('slack_event', (arg) => {
      if (str(arg.type) !== 'events_api') return;
      this.enqueue(arg, () => this.handleSlackEvent(arg));
    });
    on('interactive', (arg) => {
      this.enqueue(arg, () => this.handleInteractive(arg));
    });
  }

  /**
   * 受信イベントを 1 本の Promise チェーンに積み、受け取った順に 1 件ずつ処理する。
   * ack は列を待たずにすぐ返し、処理本体は ack の完了と前のイベントの処理の完了を待ってから始める。
   */
  private enqueue(arg: RawEvent, task: () => Promise<void>): void {
    const acked = this.ackFirst(arg);
    this.inbound = this.inbound
      .then(() => acked)
      .then(task)
      .catch((e: unknown) => this.logger.error('受信イベントの処理で例外', e));
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /**
   * 張り直し。SDK の start() は古い WebSocket を片付けずに新しいものを作るので、
   * 先に disconnect() で古い接続を閉じてから start() する。失敗したらバックオフして再度予約する。
   */
  private async reconnect(): Promise<void> {
    if (this.stopping || this.connected) return;
    this.logger.warn(`socket: 再接続を試みる（次の待ち ${this.backoffMs}ms）`);
    const socket = this.socket();
    this.connecting = true;
    try {
      await socket.disconnect();
      if (this.stopping) return;
      await socket.start();
      // start() の途中で stop() された場合、張れてしまった接続を閉じる
      if (this.stopping) await socket.disconnect();
    } catch (e) {
      this.logger.error('socket: 再接続に失敗', e);
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
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

  /** events_api の処理本体（ack は enqueue で済ませてある） */
  private async handleSlackEvent(arg: RawEvent): Promise<void> {
    try {
      const body = obj(arg.body) ?? {};
      const ev = obj(body.event) ?? {};
      if (str(ev.type) === 'app_home_opened') {
        await this.handleHomeOpened(body, ev);
        return;
      }
      if (str(ev.type) !== 'message') return;

      const msg = toInboundMessage(body);
      const result = gate(msg, this.access, this.botUserId, this.dedupe, this.handlers?.isKnownRequest, (c, t) =>
        this.isActiveThread(c, t)
      );
      if (result.kind !== 'drop') this.rememberSender(msg);
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

  /**
   * gate を通った受信から送信先を覚える。DM なら送信者の DM チャンネルを、
   * チャンネルならそのスレッド（メンションされたら続きはメンション無しでも受け付ける）を覚える
   */
  private rememberSender(msg: InboundMessage): void {
    if (msg.channelType === 'im') {
      this.learnDmChannel(msg.user, msg.channel);
      return;
    }
    const threadTs = msg.threadTs ?? msg.ts;
    if (msg.channel && threadTs) this.markActiveThread(msg.channel, threadTs);
  }

  /**
   * init() で conversations.open に失敗した許可ユーザーの DM を、gate を通った DM の受信（team・im・allowFrom を確認済み）から覚える。
   * チャンネルの受信からは覚えない（チャンネル ID を DM と取り違えないため。呼び出し側で channel_type を見る）。
   * 既に DM が分かっているユーザーは上書きしない。
   */
  private learnDmChannel(user: string | undefined, channel: string | undefined): void {
    if (!user || !channel || this.dmChannels.has(user)) return;
    if (!this.access.allowFrom.includes(user)) return;
    this.dmChannels.set(user, channel);
    this.allowedChannelIds.add(channel);
    this.logger.info(`受信した DM から送信先を追加 user=${user} channel=${channel}`);
  }

  /** ホームタブが開かれた。別のワークスペースのイベントと、ホーム以外のタブ（メッセージ・概要）は無視する */
  private async handleHomeOpened(body: RawEvent, ev: RawEvent): Promise<void> {
    const user = str(ev.user);
    if (str(body.team_id) !== this.access.teamId || !user || str(ev.tab) !== 'home') return;
    await this.handlers?.onHomeOpened?.(user, this.access.allowFrom.includes(user));
  }

  /** ユーザーのホームタブに view を出す。失敗しても投げない（ログに残す） */
  async publishHome(userId: string, view: unknown): Promise<void> {
    try {
      await this.web.views.publish({ user_id: userId, view });
    } catch (e) {
      this.logger.warn(`ホームタブの更新に失敗 user=${userId}`, e);
    }
  }

  /** access.channels のチャンネルのスレッドに、ボットが関わっているか */
  isActiveThread(channel: string, threadTs: string): boolean {
    return this.activeThreads.has(`${channel}:${threadTs}`);
  }

  /** ボットが関わったスレッドとして覚える（access.channels のチャンネルだけ。DM は常に受け付けるので覚えない） */
  private markActiveThread(channel: string, threadTs: string): void {
    if (!(this.access.channels ?? []).includes(channel)) return;
    const key = `${channel}:${threadTs}`;
    this.activeThreads.delete(key);
    this.activeThreads.set(key, true);
    if (this.activeThreads.size > ACTIVE_THREAD_CAPACITY) {
      const oldest = this.activeThreads.keys().next();
      if (!oldest.done) this.activeThreads.delete(oldest.value);
    }
  }

  /** interactive の処理本体（ack は enqueue で済ませてある） */
  private async handleInteractive(arg: RawEvent): Promise<void> {
    try {
      const { input, ctx } = toBlockActionInput(obj(arg.body) ?? {});
      const parsed = parseBlockAction(input, this.access, this.allowedChannelIds);
      await this.handlers?.onAction(parsed, ctx);
    } catch (e) {
      this.logger.error('interactive の処理で例外', e);
    }
  }

  // --- 送信 -----------------------------------------------------------------

  private assertAllowed(channel: string): void {
    if (!this.allowedChannelIds.has(channel)) {
      throw new Error('許可されていない送信先チャンネル');
    }
  }

  /**
   * テキストを送る。許可ユーザーの DM と access.channels 以外には送らない（投げる）。一斉メンションは無効化し、空なら何も送らない。
   * まず markdown_text で 11000 文字ごとに送り、markdown_text が拒否されたら（isMarkdownRejection）
   * そのチャンク以降は text（& < > をエスケープ、3900 文字ごと）に切り替える。それ以外のエラーはそのまま投げる。
   * 長文は分割して順に送る。途中のチャンクで失敗した場合、1 通以上送れていれば
   * 例外のメッセージに `sent=N`（送れた件数）を付けて投げる（Claude が再送の範囲を判断できるように）。
   */
  async postText(channel: string, text: string, threadTs?: string): Promise<{ ts: string[] }> {
    this.assertAllowed(channel);
    const safe = neutralizeBroadcasts(text);
    const tsList: string[] = [];
    if (safe === '') return { ts: tsList };

    try {
      await this.postChunks(channel, safe, threadTs, tsList);
    } catch (e) {
      if (tsList.length === 0) throw e;
      throw new Error(`${errMessage(e)} (sent=${tsList.length})`, { cause: e });
    } finally {
      const root = threadTs ?? tsList[0];
      if (root) this.markActiveThread(channel, root);
    }
    return { ts: tsList };
  }

  /** postText の本体。送れたメッセージの ts を tsList に積む */
  private async postChunks(channel: string, safe: string, threadTs: string | undefined, tsList: string[]): Promise<void> {
    const blocksOfMarkdown = chunkText(safe, MARKDOWN_LIMIT);
    let useMarkdown = true;

    for (const piece of blocksOfMarkdown) {
      if (useMarkdown) {
        try {
          const res = await this.web.chat.postMessage({
            channel,
            markdown_text: piece,
            ...threadParam(threadTs),
            ...NO_UNFURL,
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
          ...threadParam(threadTs),
          ...NO_UNFURL,
        });
        if (res.ts) tsList.push(res.ts);
      }
    }
  }

  async postBlocks(channel: string, text: string, blocks: unknown[], threadTs?: string): Promise<{ ts: string }> {
    this.assertAllowed(channel);
    const res = await this.web.chat.postMessage({
      channel,
      text: neutralizeBroadcasts(text),
      blocks,
      ...threadParam(threadTs),
      ...NO_UNFURL,
    });
    const root = threadTs ?? res.ts;
    if (root) this.markActiveThread(channel, root);
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
