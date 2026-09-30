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
}

export function makeWeb(): FakeWeb {
  const calls: ApiCall[] = [];
  let seq = 0;
  const web: FakeWeb = {
    calls,
    rejectMarkdown: undefined,
    reactionError: undefined,
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
  };
  return web;
}

export interface FakeSocket extends SocketClientLike {
  listeners: Map<string, ((arg: unknown) => void)[]>;
  started: number;
  disconnected: number;
  emit(event: string, arg: unknown): void;
}

export function makeSocket(): FakeSocket {
  const listeners = new Map<string, ((arg: unknown) => void)[]>();
  return {
    listeners,
    started: 0,
    disconnected: 0,
    on(event: string, listener: (...args: never[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener as unknown as (arg: unknown) => void);
      listeners.set(event, list);
      return this;
    },
    async start() {
      this.started += 1;
      return {};
    },
    async disconnect() {
      this.disconnected += 1;
    },
    emit(event: string, arg: unknown) {
      for (const l of listeners.get(event) ?? []) l(arg);
    },
  };
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
