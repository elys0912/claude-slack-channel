// Slack の Web API / Socket Mode を差し替えるテスト用の偽物（slack.test.ts / app.test.ts で共用）
import type { SlackWebApiLike, SocketClientLike } from '../../src/slack.js';
import type { ParsedAccess } from '../../src/config.js';

export const ACCESS: ParsedAccess = { teamId: 'T123ABC', allowFrom: ['U111AAA', 'U222BBB'] };
export const DM1 = 'D111AAA';
export const DM2 = 'D222BBB';
export const BOT = 'UBOT000';

export interface ApiCall {
  method: string;
  args: Record<string, unknown>;
}

export interface FakeWeb extends SlackWebApiLike {
  calls: ApiCall[];
  /** postMessage が markdown_text を含むとき投げるエラー */
  rejectMarkdown: unknown;
  reactionError: unknown;
  /** files.info が返す file */
  file: Record<string, unknown> | undefined;
}

export function makeWeb(): FakeWeb {
  const calls: ApiCall[] = [];
  let seq = 0;
  const web: FakeWeb = {
    calls,
    rejectMarkdown: undefined,
    reactionError: undefined,
    file: undefined,
    auth: {
      test: async () => {
        calls.push({ method: 'auth.test', args: {} });
        return { ok: true, team_id: 'T123ABC', user_id: BOT };
      },
    },
    conversations: {
      open: async (args) => {
        calls.push({ method: 'conversations.open', args });
        return { ok: true, channel: { id: args.users === 'U111AAA' ? DM1 : DM2 } };
      },
    },
    chat: {
      postMessage: async (args) => {
        if (args.markdown_text !== undefined && web.rejectMarkdown !== undefined) {
          calls.push({ method: 'chat.postMessage:rejected', args });
          throw web.rejectMarkdown;
        }
        calls.push({ method: 'chat.postMessage', args });
        seq += 1;
        return { ok: true, ts: `100.${seq}` };
      },
      update: async (args) => {
        calls.push({ method: 'chat.update', args });
        return { ok: true, ts: String(args.ts) };
      },
    },
    reactions: {
      add: async (args) => {
        calls.push({ method: 'reactions.add', args });
        if (web.reactionError !== undefined) throw web.reactionError;
        return { ok: true };
      },
    },
    views: {
      publish: async (args) => {
        calls.push({ method: 'views.publish', args });
        return { ok: true };
      },
    },
    files: {
      info: async (args) => {
        calls.push({ method: 'files.info', args });
        return { ok: true, ...(web.file ? { file: web.file } : {}) };
      },
    },
  };
  return web;
}

/**
 * SocketModeClient（autoReconnectEnabled: false）の振る舞いを模す。
 * - start() は冪等ではない。呼ぶたびに新しい WebSocket を作り、古いものは閉じない（leaked で数える）
 * - start() が成功すると connecting → connected を emit する
 * - disconnect() は disconnecting → disconnected を emit する（接続が無くても disconnected は出る）
 * - 自動再接続は無効なので、接続が切れると disconnected を emit するだけ（drop() で模す）
 */
export interface FakeSocket extends SocketClientLike {
  listeners: Map<string, ((arg: unknown) => void)[]>;
  started: number;
  disconnected: number;
  /** 開いている WebSocket の数 */
  open: number;
  /** 古い WebSocket を閉じないまま start() された回数 */
  leaked: number;
  /**
   * 次以降の start() を失敗させる。'auth' は apps.connections.open の失敗（disconnected を出さずに reject）、
   * 'closed' は hello 前に WebSocket が閉じた場合（disconnected を出してから reject）
   */
  failStart: ('auth' | 'closed')[];
  emit(event: string, arg: unknown): void;
  /** サーバー側から接続が切られたことを模す */
  drop(): void;
}

export function makeSocket(): FakeSocket {
  const listeners = new Map<string, ((arg: unknown) => void)[]>();
  const socket: FakeSocket = {
    listeners,
    started: 0,
    disconnected: 0,
    open: 0,
    leaked: 0,
    failStart: [],
    on(event: string, listener: (...args: never[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener as unknown as (arg: unknown) => void);
      listeners.set(event, list);
      return socket;
    },
    async start() {
      socket.started += 1;
      const failure = socket.failStart.shift();
      if (failure === 'auth') throw platformError('internal_error');
      if (socket.open > 0) socket.leaked += 1;
      socket.open += 1;
      socket.emit('connecting', {});
      if (failure === 'closed') {
        socket.open -= 1;
        socket.emit('disconnected', {});
        throw new Error('closed before hello');
      }
      socket.emit('connected', {});
      return {};
    },
    async disconnect() {
      socket.disconnected += 1;
      socket.emit('disconnecting', {});
      socket.open = 0;
      socket.emit('disconnected', {});
    },
    emit(event: string, arg: unknown) {
      for (const l of listeners.get(event) ?? []) l(arg);
    },
    drop() {
      socket.open = 0;
      socket.emit('disconnected', {});
    },
  };
  return socket;
}

/** @slack/web-api が投げる platform error（data.error にコードが入る）を模す */
export function platformError(code: string): Error & { data: { error: string } } {
  const e = new Error(`An API error occurred: ${code}`) as Error & { data: { error: string } };
  e.data = { error: code };
  return e;
}

/** マイクロタスクを吐き出して非同期ハンドラの完了を待つ */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}
