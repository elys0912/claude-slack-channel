import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlackBridge, isMarkdownRejection, toInboundMessage } from '../src/slack.js';
import type { SlackWebApiLike, SocketClientLike } from '../src/slack.js';
import { Logger } from '../src/log.js';
import type { ParsedAccess } from '../src/config.js';
import type { GateResult } from '../src/gate.js';
import type { ActionParse } from '../src/permission.js';

const ACCESS: ParsedAccess = { teamId: 'T123ABC', allowFrom: ['U111AAA', 'U222BBB'] };
const DM1 = 'D111AAA';
const DM2 = 'D222BBB';
const BOT = 'UBOT000';

interface ApiCall {
  method: string;
  args: Record<string, unknown>;
}

interface FakeWeb extends SlackWebApiLike {
  calls: ApiCall[];
  /** postMessage が markdown_text を含むとき投げるエラー */
  rejectMarkdown: unknown;
  reactionError: unknown;
}

function makeWeb(): FakeWeb {
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

interface FakeSocket extends SocketClientLike {
  listeners: Map<string, ((arg: unknown) => void)[]>;
  started: number;
  disconnected: number;
  emit(event: string, arg: unknown): void;
}

function makeSocket(): FakeSocket {
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

function makeBridge(): { bridge: SlackBridge; web: FakeWeb; socket: FakeSocket } {
  const web = makeWeb();
  const socket = makeSocket();
  const bridge = new SlackBridge({
    botToken: 'xoxb-TEST-DUMMY',
    appToken: 'xapp-TEST-DUMMY',
    access: ACCESS,
    logger: new Logger({ stderr: false }),
    web,
    socket,
  });
  return { bridge, web, socket };
}

function platformError(code: string): Error & { data: { error: string } } {
  const e = new Error(`An API error occurred: ${code}`) as Error & { data: { error: string } };
  e.data = { error: code };
  return e;
}

/** マイクロタスクを吐き出して非同期ハンドラの完了を待つ */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe('isMarkdownRejection', () => {
  it('invalid_arguments を拒否とみなす', () => {
    expect(isMarkdownRejection(platformError('invalid_arguments'))).toBe(true);
  });
  it('msg_too_long も拒否とみなす', () => {
    expect(isMarkdownRejection(platformError('msg_too_long'))).toBe(true);
  });
  it('channel_not_found は拒否ではない', () => {
    expect(isMarkdownRejection(platformError('channel_not_found'))).toBe(false);
  });
});

describe('toInboundMessage', () => {
  it('events_api の payload を詰め替える', () => {
    const msg = toInboundMessage({
      team_id: 'T123ABC',
      event_id: 'Ev1',
      event: {
        type: 'message',
        channel: DM1,
        channel_type: 'im',
        user: 'U111AAA',
        text: 'hello',
        ts: '1.1',
        thread_ts: '1.0',
        files: [{ name: 'a.png', mimetype: 'image/png', size: 10 }],
      },
    });
    expect(msg.teamId).toBe('T123ABC');
    expect(msg.channel).toBe(DM1);
    expect(msg.threadTs).toBe('1.0');
    expect(msg.files?.[0]?.name).toBe('a.png');
  });
});

describe('SlackBridge.init', () => {
  it('team_id が一致すれば DM チャンネルを集める', async () => {
    const { bridge, web } = makeBridge();
    const res = await bridge.init();
    expect(res.botUserId).toBe(BOT);
    expect(res.teamId).toBe('T123ABC');
    expect(res.dmChannels.get('U111AAA')).toBe(DM1);
    expect(bridge.allowedDmChannels.has(DM2)).toBe(true);
    expect(web.calls[0]?.method).toBe('auth.test');
  });

  it('team_id が違えば Error', async () => {
    const { bridge, web } = makeBridge();
    web.auth.test = async () => ({ ok: true, team_id: 'TOTHER1', user_id: BOT });
    await expect(bridge.init()).rejects.toThrow(/team_id/);
  });
});

describe('SlackBridge.postText', () => {
  let bridge: SlackBridge;
  let web: FakeWeb;

  beforeEach(async () => {
    const made = makeBridge();
    bridge = made.bridge;
    web = made.web;
    await bridge.init();
    web.calls.length = 0;
  });

  it('長文を markdown_text で分割して送る', async () => {
    const text = ('あ'.repeat(99) + '\n').repeat(300); // 30000 文字程度
    const res = await bridge.postText(DM1, text);
    const posts = web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts.length).toBeGreaterThan(1);
    expect(res.ts.length).toBe(posts.length);
    for (const p of posts) {
      expect(typeof p.args.markdown_text).toBe('string');
      expect(String(p.args.markdown_text).length).toBeLessThanOrEqual(11000);
      expect(p.args.channel).toBe(DM1);
    }
  });

  it('短い本文は 1 通で送る', async () => {
    await bridge.postText(DM1, 'hello', '1.0');
    const posts = web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts.length).toBe(1);
    expect(posts[0]?.args.markdown_text).toBe('hello');
    expect(posts[0]?.args.thread_ts).toBe('1.0');
  });

  it('markdown_text が拒否されたら text に切り替えて送り直す', async () => {
    web.rejectMarkdown = platformError('invalid_arguments');
    const text = 'a'.repeat(20000) + ' <tag> & more';
    const res = await bridge.postText(DM1, text);

    const rejected = web.calls.filter((c) => c.method === 'chat.postMessage:rejected');
    const sent = web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(rejected.length).toBe(1); // 拒否は最初の 1 回だけ
    expect(sent.length).toBeGreaterThan(1);
    expect(res.ts.length).toBe(sent.length);
    for (const p of sent) {
      expect(p.args.markdown_text).toBeUndefined();
      expect(String(p.args.text).length).toBeLessThanOrEqual(3900);
    }
    // escapeMrkdwn が効いている
    expect(sent.map((p) => String(p.args.text)).join('')).toContain('&lt;tag&gt;');
  });

  it('markdown 以外のエラーはそのまま投げる', async () => {
    web.rejectMarkdown = platformError('channel_not_found');
    await expect(bridge.postText(DM1, 'hi')).rejects.toThrow(/channel_not_found/);
  });

  it('一斉メンションを無効化する', async () => {
    await bridge.postText(DM1, '<!channel> みんな見て @here');
    const sent = String(web.calls[0]?.args.markdown_text);
    expect(sent).not.toContain('<!channel>');
    expect(sent).toContain('@​channel');
    expect(sent).toContain('@​here');
  });

  it('許可されていないチャンネルには送れない', async () => {
    await expect(bridge.postText('D999ZZZ', 'hi')).rejects.toThrow(/許可されていない/);
    await expect(bridge.postBlocks('D999ZZZ', 'hi', [])).rejects.toThrow(/許可されていない/);
    await expect(bridge.updateBlocks('D999ZZZ', '1.0', 'hi', [])).rejects.toThrow(/許可されていない/);
    await expect(bridge.updateText('D999ZZZ', '1.0', 'hi')).rejects.toThrow(/許可されていない/);
    await expect(bridge.addReaction('D999ZZZ', '1.0', 'eyes')).rejects.toThrow(/許可されていない/);
    expect(web.calls.length).toBe(0);
  });
});

describe('SlackBridge の送信系', () => {
  it('postBlocks / updateBlocks は text を無害化する', async () => {
    const { bridge, web } = makeBridge();
    await bridge.init();
    web.calls.length = 0;

    const r = await bridge.postBlocks(DM1, '<!here> perm', [{ type: 'section' }]);
    expect(r.ts).toBe('100.1');
    expect(String(web.calls[0]?.args.text)).toContain('@​here');

    await bridge.updateBlocks(DM1, '100.1', '<!channel> done', []);
    expect(String(web.calls[1]?.args.text)).toContain('@​channel');
  });

  it('addReaction は失敗しても投げない', async () => {
    const { bridge, web } = makeBridge();
    await bridge.init();
    web.reactionError = platformError('already_reacted');
    await expect(bridge.addReaction(DM1, '1.0', 'eyes')).resolves.toBeUndefined();
  });

  it('postToAll は許可ユーザー全員に送る', async () => {
    const { bridge, web } = makeBridge();
    await bridge.init();
    web.calls.length = 0;
    const res = await bridge.postToAll('perm', [{ type: 'section' }]);
    expect(res.map((r) => r.channel)).toEqual([DM1, DM2]);
    expect(web.calls.filter((c) => c.method === 'chat.postMessage').length).toBe(2);
  });

  it('postToAll は threadFor が返したスレッドにだけ返信する', async () => {
    const { bridge, web } = makeBridge();
    await bridge.init();
    web.calls.length = 0;
    await bridge.postToAll('perm', [{ type: 'section' }], (ch) => (ch === DM1 ? '5.0' : undefined));
    const posts = web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts[0]?.args.channel).toBe(DM1);
    expect(posts[0]?.args.thread_ts).toBe('5.0');
    expect(posts[1]?.args.channel).toBe(DM2);
    expect(posts[1]?.args).not.toHaveProperty('thread_ts');
  });
});

describe('SlackBridge の受信', () => {
  function messageEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'events_api',
      envelope_id: 'env-1',
      body: {
        team_id: 'T123ABC',
        event_id: 'Ev1',
        event: {
          type: 'message',
          channel_type: 'im',
          channel: DM1,
          user: 'U111AAA',
          text: 'hello',
          ts: '1.1',
          ...overrides,
        },
      },
    };
  }

  it('events_api の message を gate に通して onMessage を呼ぶ。ack が先', async () => {
    const { bridge, socket } = makeBridge();
    await bridge.init();
    const order: string[] = [];
    const seen: GateResult[] = [];
    await bridge.start({
      onMessage: (r) => {
        order.push('handler');
        seen.push(r);
      },
      onAction: () => undefined,
    });
    expect(socket.started).toBe(1);

    socket.emit('slack_event', {
      ...messageEnvelope(),
      ack: async () => {
        order.push('ack');
      },
    });
    await flush();

    expect(order).toEqual(['ack', 'handler']);
    expect(seen.length).toBe(1);
    expect(seen[0]?.kind).toBe('deliver');
    if (seen[0]?.kind === 'deliver') {
      expect(seen[0].content).toBe('hello');
      expect(seen[0].meta.chat_id).toBe(DM1);
      expect(seen[0].meta.thread_ts).toBe('1.1');
    }
  });

  it('許可されていないユーザーは drop になる', async () => {
    const { bridge, socket } = makeBridge();
    await bridge.init();
    const seen: GateResult[] = [];
    await bridge.start({ onMessage: (r) => void seen.push(r), onAction: () => undefined });

    socket.emit('slack_event', { ...messageEnvelope({ user: 'U999ZZZ' }), ack: async () => undefined });
    await flush();
    expect(seen[0]?.kind).toBe('drop');
  });

  it('自分（bot）の発言は drop になる', async () => {
    const { bridge, socket } = makeBridge();
    await bridge.init();
    const seen: GateResult[] = [];
    await bridge.start({ onMessage: (r) => void seen.push(r), onAction: () => undefined });

    socket.emit('slack_event', { ...messageEnvelope({ user: BOT }), ack: async () => undefined });
    await flush();
    expect(seen[0]?.kind).toBe('drop');
  });

  it('events_api 以外は slack_event では扱わない（ack もしない）', async () => {
    const { bridge, socket } = makeBridge();
    await bridge.init();
    let acked = 0;
    const seen: GateResult[] = [];
    await bridge.start({ onMessage: (r) => void seen.push(r), onAction: () => undefined });

    socket.emit('slack_event', {
      type: 'interactive',
      body: {},
      ack: async () => {
        acked += 1;
      },
    });
    await flush();
    expect(acked).toBe(0);
    expect(seen.length).toBe(0);
  });

  it('onMessage が例外を投げても落ちない', async () => {
    const { bridge, socket } = makeBridge();
    await bridge.init();
    await bridge.start({
      onMessage: () => {
        throw new Error('boom');
      },
      onAction: () => undefined,
    });
    socket.emit('slack_event', { ...messageEnvelope(), ack: async () => undefined });
    await flush();
    // 例外が外に漏れなければここに到達する
    expect(true).toBe(true);
  });

  it('block_actions を parseBlockAction に通す。ack が先', async () => {
    const { bridge, socket } = makeBridge();
    await bridge.init();
    const order: string[] = [];
    const seen: ActionParse[] = [];
    const ctxs: { userId?: string; channelId?: string; messageTs?: string; value?: string }[] = [];
    await bridge.start({
      onMessage: () => undefined,
      onAction: (p, ctx) => {
        order.push('handler');
        seen.push(p);
        ctxs.push(ctx);
      },
    });

    socket.emit('interactive', {
      type: 'interactive',
      body: {
        type: 'block_actions',
        team: { id: 'T123ABC' },
        user: { id: 'U111AAA' },
        channel: { id: DM1 },
        container: { message_ts: '55.5' },
        actions: [{ action_id: 'perm_allow', value: 'abcde' }],
      },
      ack: async () => {
        order.push('ack');
      },
    });
    await flush();

    expect(order).toEqual(['ack', 'handler']);
    expect(seen[0]).toEqual({ ok: true, kind: 'verdict', verdict: { requestId: 'abcde', behavior: 'allow' } });
    expect(ctxs[0]).toEqual({ userId: 'U111AAA', channelId: DM1, messageTs: '55.5', value: 'abcde' });
  });

  it('許可外チャンネルの block_actions は ok:false になる', async () => {
    const { bridge, socket } = makeBridge();
    await bridge.init();
    const seen: ActionParse[] = [];
    await bridge.start({ onMessage: () => undefined, onAction: (p) => void seen.push(p) });

    socket.emit('interactive', {
      type: 'interactive',
      body: {
        type: 'block_actions',
        team: { id: 'T123ABC' },
        user: { id: 'U111AAA' },
        channel: { id: 'D999ZZZ' },
        actions: [{ action_id: 'perm_allow', value: 'abcde' }],
      },
      ack: async () => undefined,
    });
    await flush();
    expect(seen[0]).toEqual({ ok: false, reason: 'channel_not_allowed' });
  });

  it('onAction が例外を投げても落ちない', async () => {
    const { bridge, socket } = makeBridge();
    await bridge.init();
    await bridge.start({
      onMessage: () => undefined,
      onAction: () => {
        throw new Error('boom');
      },
    });
    socket.emit('interactive', { type: 'interactive', body: {}, ack: async () => undefined });
    await flush();
    expect(true).toBe(true);
  });

  it('stop すると disconnect される', async () => {
    const { bridge, socket } = makeBridge();
    await bridge.init();
    await bridge.start({ onMessage: () => undefined, onAction: () => undefined });
    await bridge.stop();
    expect(socket.disconnected).toBe(1);
  });

  it('disconnected が続くとバックオフして start をやり直す', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, socket } = makeBridge();
      await bridge.init();
      await bridge.start({ onMessage: () => undefined, onAction: () => undefined });
      expect(socket.started).toBe(1);

      socket.emit('disconnected', {});
      await vi.advanceTimersByTimeAsync(1000);
      expect(socket.started).toBe(2);

      // 再接続後も繋がらないままなら、待ち時間が伸びる
      socket.emit('disconnected', {});
      await vi.advanceTimersByTimeAsync(1000);
      expect(socket.started).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(socket.started).toBe(3);

      // connected が来たらバックオフがリセットされる
      socket.emit('connected', {});
      socket.emit('disconnected', {});
      await vi.advanceTimersByTimeAsync(1000);
      expect(socket.started).toBe(4);

      await bridge.stop();
      socket.emit('disconnected', {});
      await vi.advanceTimersByTimeAsync(60000);
      expect(socket.started).toBe(4); // stop 後は再接続しない
    } finally {
      vi.useRealTimers();
    }
  });

  it('接続状態のイベントで落ちない', async () => {
    const { bridge, socket } = makeBridge();
    await bridge.init();
    await bridge.start({ onMessage: () => undefined, onAction: () => undefined });
    for (const s of ['connecting', 'connected', 'reconnecting', 'disconnecting']) {
      socket.emit(s, {});
    }
    expect(true).toBe(true);
    await bridge.stop();
  });
});
