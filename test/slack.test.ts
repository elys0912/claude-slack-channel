import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlackBridge, isMarkdownRejection, toBlockActionInput, toInboundMessage } from '../src/slack.js';
import type { ActionContext } from '../src/slack.js';
import { Logger } from '../src/log.js';
import type { GateResult } from '../src/gate.js';
import type { ActionParse } from '../src/permission.js';
import { ACCESS, BOT, DM1, DM2, flush, makeSocket, makeWeb, platformError } from './helpers/fake-slack.js';
import type { FakeSocket, FakeWeb } from './helpers/fake-slack.js';

function makeBridge(): { bridge: SlackBridge; web: FakeWeb; socket: FakeSocket; logger: Logger } {
  const web = makeWeb();
  const socket = makeSocket();
  const logger = new Logger({ stderr: false });
  const bridge = new SlackBridge({
    botToken: 'xoxb-TEST-DUMMY',
    appToken: 'xapp-TEST-DUMMY',
    access: ACCESS,
    logger,
    web,
    socket,
  });
  return { bridge, web, socket, logger };
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
    expect(res.dmChannelCount).toBe(2);
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

  it('onMessage が例外を投げても落ちず、logger.error に記録される', async () => {
    const { bridge, socket, logger } = makeBridge();
    const errorSpy = vi.spyOn(logger, 'error');
    await bridge.init();
    await bridge.start({
      onMessage: () => {
        throw new Error('boom');
      },
      onAction: () => undefined,
    });
    socket.emit('slack_event', { ...messageEnvelope(), ack: async () => undefined });
    await flush();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain('slack_event');
    expect((errorSpy.mock.calls[0]?.[1] as Error).message).toBe('boom');
  });

  it('block_actions を parseBlockAction に通す。ack が先', async () => {
    const { bridge, socket } = makeBridge();
    await bridge.init();
    const order: string[] = [];
    const seen: ActionParse[] = [];
    const ctxs: ActionContext[] = [];
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
    expect(ctxs[0]).toEqual({ userId: 'U111AAA', channelId: DM1, messageTs: '55.5' });
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

  it('onAction が例外を投げても落ちず、logger.error に記録される', async () => {
    const { bridge, socket, logger } = makeBridge();
    const errorSpy = vi.spyOn(logger, 'error');
    await bridge.init();
    await bridge.start({
      onMessage: () => undefined,
      onAction: () => {
        throw new Error('boom');
      },
    });
    socket.emit('interactive', { type: 'interactive', body: {}, ack: async () => undefined });
    await flush();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain('interactive');
    expect((errorSpy.mock.calls[0]?.[1] as Error).message).toBe('boom');
  });

  it('stop すると disconnect される', async () => {
    const { bridge, socket } = makeBridge();
    await bridge.init();
    await bridge.start({ onMessage: () => undefined, onAction: () => undefined });
    await bridge.stop();
    expect(socket.disconnected).toBe(1);
  });

  it('切断されたら、古い接続を disconnect してから start し直す', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, socket } = makeBridge();
      await bridge.init();
      await bridge.start({ onMessage: () => undefined, onAction: () => undefined });
      expect(socket.started).toBe(1);

      socket.drop();
      await vi.advanceTimersByTimeAsync(999);
      expect(socket.started).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(socket.disconnected).toBe(1);
      expect(socket.started).toBe(2);
      expect(socket.leaked).toBe(0);
      expect(socket.open).toBe(1);

      // 張り直しの disconnect() が出す disconnected で、さらに再接続を予約しない
      await vi.advanceTimersByTimeAsync(120000);
      expect(socket.started).toBe(2);

      // 繋がったのでバックオフは初期値に戻っている
      socket.drop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(socket.started).toBe(3);
      expect(socket.leaked).toBe(0);
      await bridge.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('start() が失敗したらバックオフを伸ばしてやり直し、繋がったら初期値に戻す', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, socket, logger } = makeBridge();
      const errorSpy = vi.spyOn(logger, 'error');
      await bridge.init();
      await bridge.start({ onMessage: () => undefined, onAction: () => undefined });

      socket.failStart = ['auth', 'closed'];
      socket.drop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(socket.started).toBe(2); // 1 回目: apps.connections.open の失敗
      await vi.advanceTimersByTimeAsync(1999);
      expect(socket.started).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(socket.started).toBe(3); // 2 回目: hello 前に切断
      await vi.advanceTimersByTimeAsync(3999);
      expect(socket.started).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(socket.started).toBe(4); // 3 回目で成功
      expect(socket.open).toBe(1);
      expect(socket.leaked).toBe(0);
      expect(errorSpy.mock.calls.filter((c) => String(c[0]).includes('再接続に失敗'))).toHaveLength(2);

      socket.drop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(socket.started).toBe(5);
      await bridge.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop 後は再接続しない（予約済みの再接続も取り消す）', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, socket } = makeBridge();
      await bridge.init();
      await bridge.start({ onMessage: () => undefined, onAction: () => undefined });

      socket.drop();
      await bridge.stop();
      socket.drop();
      await vi.advanceTimersByTimeAsync(120000);
      expect(socket.started).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('最初の start() の途中で切断されても、別途再接続を予約しない', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, socket } = makeBridge();
      await bridge.init();
      socket.failStart = ['closed'];
      await expect(bridge.start({ onMessage: () => undefined, onAction: () => undefined })).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(120000);
      expect(socket.started).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('接続状態のイベントは info ログに残り、error は出ない', async () => {
    const { bridge, socket, logger } = makeBridge();
    const infoSpy = vi.spyOn(logger, 'info');
    const errorSpy = vi.spyOn(logger, 'error');
    await bridge.init();
    await bridge.start({ onMessage: () => undefined, onAction: () => undefined });
    infoSpy.mockClear();
    for (const s of ['connecting', 'connected', 'reconnecting', 'disconnecting']) {
      socket.emit(s, {});
    }
    expect(infoSpy.mock.calls.map((c) => c[0])).toEqual([
      'socket: connecting',
      'socket: connected',
      'socket: reconnecting',
      'socket: disconnecting',
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
    await bridge.stop();
  });
});

// --- 現状固定（受信 payload の詰め替えと送信エラーの扱い） ---
describe('toBlockActionInput', () => {
  it('block_actions の payload から parseBlockAction の入力と位置情報を取り出す', () => {
    const { input, ctx } = toBlockActionInput({
      type: 'block_actions',
      team: { id: 'T123ABC' },
      user: { id: 'U111AAA' },
      channel: { id: DM1 },
      container: { message_ts: '55.5' },
      message: { ts: '77.7' },
      actions: [{ action_id: 'perm_allow', value: 'abcde' }, { action_id: 'ignored', value: 'zzzzz' }],
    });
    expect(input).toEqual({
      type: 'block_actions',
      teamId: 'T123ABC',
      userId: 'U111AAA',
      channelId: DM1,
      actionId: 'perm_allow',
      value: 'abcde',
    });
    expect(ctx).toEqual({ userId: 'U111AAA', channelId: DM1, messageTs: '55.5' });
  });

  it('container.message_ts が無ければ message.ts を使う', () => {
    const { ctx } = toBlockActionInput({ message: { ts: '77.7' } });
    expect(ctx.messageTs).toBe('77.7');
  });

  it('actions が配列でない／要素がオブジェクトでない場合は action 無し', () => {
    expect(toBlockActionInput({ actions: { action_id: 'perm_allow' } }).input.actionId).toBeUndefined();
    expect(toBlockActionInput({ actions: ['perm_allow'] }).input.actionId).toBeUndefined();
  });

  it('文字列でない値は undefined になる', () => {
    const { input, ctx } = toBlockActionInput({
      type: 1,
      team: { id: null },
      user: 'U111AAA',
      channel: { id: ['D'] },
      container: { message_ts: 55.5 },
      actions: [{ action_id: {}, value: 5 }],
    });
    expect(input).toEqual({
      type: undefined,
      teamId: undefined,
      userId: undefined,
      channelId: undefined,
      actionId: undefined,
      value: undefined,
    });
    expect(ctx).toEqual({ userId: undefined, channelId: undefined, messageTs: undefined });
  });
});

describe('toInboundMessage の現状固定', () => {
  it('user_team が無ければ event.team を userTeam に使う', () => {
    const msg = toInboundMessage({ team_id: 'T123ABC', event: { team: 'TFALLBACK' } });
    expect(msg.userTeam).toBe('TFALLBACK');
  });

  it('user_team があれば event.team より優先する', () => {
    const msg = toInboundMessage({ team_id: 'T123ABC', event: { user_team: 'TUSER', team: 'TFALLBACK' } });
    expect(msg.userTeam).toBe('TUSER');
  });

  it('files が配列でなければ undefined になる', () => {
    const msg = toInboundMessage({ event: { files: 'not-an-array' } });
    expect(msg.files).toBeUndefined();
  });

  it('files の size が数値でなければ undefined、name/mimetype が文字列でなければ undefined', () => {
    const msg = toInboundMessage({ event: { files: [{ name: 1, mimetype: null, size: '10' }, 'junk'] } });
    expect(msg.files).toEqual([
      { name: undefined, mimetype: undefined, size: undefined },
      { name: undefined, mimetype: undefined, size: undefined },
    ]);
  });

  it('event が無ければ全項目 undefined', () => {
    const msg = toInboundMessage({});
    expect(msg).toEqual({
      teamId: undefined,
      eventId: undefined,
      channelType: undefined,
      channel: undefined,
      user: undefined,
      userTeam: undefined,
      botId: undefined,
      subtype: undefined,
      text: undefined,
      ts: undefined,
      threadTs: undefined,
      files: undefined,
    });
  });
});

describe('SlackBridge の受信（現状固定）', () => {
  async function startWithActionCapture() {
    const made = makeBridge();
    await made.bridge.init();
    const seen: ActionParse[] = [];
    const ctxs: ActionContext[] = [];
    await made.bridge.start({
      onMessage: () => undefined,
      onAction: (p, ctx) => {
        seen.push(p);
        ctxs.push(ctx);
      },
    });
    return { ...made, seen, ctxs };
  }

  it('container.message_ts が無ければ message.ts を messageTs に使う', async () => {
    const { socket, ctxs } = await startWithActionCapture();
    socket.emit('interactive', {
      type: 'interactive',
      body: {
        type: 'block_actions',
        team: { id: 'T123ABC' },
        user: { id: 'U111AAA' },
        channel: { id: DM1 },
        message: { ts: '77.7' },
        actions: [{ action_id: 'perm_deny', value: 'abcde' }],
      },
      ack: async () => undefined,
    });
    await flush();
    expect(ctxs[0]?.messageTs).toBe('77.7');
  });

  it('container.message_ts があれば message.ts より優先する', async () => {
    const { socket, ctxs } = await startWithActionCapture();
    socket.emit('interactive', {
      type: 'interactive',
      body: {
        type: 'block_actions',
        team: { id: 'T123ABC' },
        user: { id: 'U111AAA' },
        channel: { id: DM1 },
        container: { message_ts: '55.5' },
        message: { ts: '77.7' },
        actions: [{ action_id: 'perm_deny', value: 'abcde' }],
      },
      ack: async () => undefined,
    });
    await flush();
    expect(ctxs[0]?.messageTs).toBe('55.5');
  });

  it('actions が配列でなければ action 無しとして invalid_request_id になる', async () => {
    const { socket, seen, ctxs } = await startWithActionCapture();
    socket.emit('interactive', {
      type: 'interactive',
      body: {
        type: 'block_actions',
        team: { id: 'T123ABC' },
        user: { id: 'U111AAA' },
        channel: { id: DM1 },
        actions: { action_id: 'perm_allow', value: 'abcde' },
      },
      ack: async () => undefined,
    });
    await flush();
    expect(seen[0]).toEqual({ ok: false, reason: 'invalid_request_id' });
    expect(ctxs[0]).toEqual({ userId: 'U111AAA', channelId: DM1, messageTs: undefined });
  });

  it('body が空でも onAction は呼ばれる（not_block_actions）', async () => {
    const { socket, seen, ctxs } = await startWithActionCapture();
    socket.emit('interactive', { type: 'interactive', body: {}, ack: async () => undefined });
    await flush();
    expect(seen[0]).toEqual({ ok: false, reason: 'not_block_actions' });
    expect(ctxs[0]).toEqual({ userId: undefined, channelId: undefined, messageTs: undefined });
  });

  it('ack が例外を投げても処理は続く（warn に記録）', async () => {
    const made = makeBridge();
    const warnSpy = vi.spyOn(made.logger, 'warn');
    await made.bridge.init();
    const seen: GateResult[] = [];
    await made.bridge.start({ onMessage: (r) => void seen.push(r), onAction: () => undefined });
    made.socket.emit('slack_event', {
      type: 'events_api',
      body: {
        team_id: 'T123ABC',
        event_id: 'Ev9',
        event: { type: 'message', channel_type: 'im', channel: DM1, user: 'U111AAA', text: 'hi', ts: '9.9' },
      },
      ack: async () => {
        throw new Error('ack failed');
      },
    });
    await flush();
    expect(seen[0]?.kind).toBe('deliver');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('ack');
  });

  it('event.type が message 以外なら ack だけして onMessage は呼ばない', async () => {
    const made = makeBridge();
    await made.bridge.init();
    let acked = 0;
    const seen: GateResult[] = [];
    await made.bridge.start({ onMessage: (r) => void seen.push(r), onAction: () => undefined });
    made.socket.emit('slack_event', {
      type: 'events_api',
      body: { team_id: 'T123ABC', event: { type: 'reaction_added' } },
      ack: async () => {
        acked += 1;
      },
    });
    await flush();
    expect(acked).toBe(1);
    expect(seen).toEqual([]);
  });

  it('onMessage に渡る raw は threadTs が無ければ ts で埋まる', async () => {
    const made = makeBridge();
    await made.bridge.init();
    const raws: unknown[] = [];
    await made.bridge.start({ onMessage: (_r, raw) => void raws.push(raw), onAction: () => undefined });
    made.socket.emit('slack_event', {
      type: 'events_api',
      body: {
        team_id: 'T123ABC',
        event_id: 'Ev1',
        event: { type: 'message', channel_type: 'im', channel: DM1, user: 'U111AAA', text: 'hi', ts: '1.1' },
      },
      ack: async () => undefined,
    });
    await flush();
    expect(raws[0]).toEqual({ channel: DM1, ts: '1.1', threadTs: '1.1', user: 'U111AAA' });
  });
});

describe('SlackBridge の送信（現状固定）', () => {
  it('ratelimited（SDK のリトライ枯渇）はそのままの例外として投げる', async () => {
    const { bridge, web } = makeBridge();
    await bridge.init();
    const err = platformError('ratelimited');
    web.rejectMarkdown = err;
    await expect(bridge.postText(DM1, 'hi')).rejects.toBe(err);
    // text へのフォールバックはしない
    expect(web.calls.filter((c) => c.method === 'chat.postMessage').length).toBe(0);
  });

  it('コードが無い汎用 Error（リトライ枯渇時）もそのまま投げる', async () => {
    const { bridge, web } = makeBridge();
    await bridge.init();
    const err = new Error('A rate limit was exceeded (retries exhausted)');
    web.rejectMarkdown = err;
    await expect(bridge.postText(DM1, 'hi')).rejects.toBe(err);
  });

  it('途中のチャンクで失敗すると、それまでの ts は返らず例外になる', async () => {
    const { bridge, web } = makeBridge();
    await bridge.init();
    web.calls.length = 0;
    const original = web.chat.postMessage;
    let n = 0;
    web.chat.postMessage = async (args) => {
      n += 1;
      if (n === 2) throw platformError('internal_error');
      return original(args);
    };
    const text = ('あ'.repeat(99) + '\n').repeat(300);
    await expect(bridge.postText(DM1, text)).rejects.toThrow(/internal_error/);
    expect(web.calls.filter((c) => c.method === 'chat.postMessage').length).toBe(1);
  });

  it('空文字の postText は何も送らず ts:[] を返す', async () => {
    const { bridge, web } = makeBridge();
    await bridge.init();
    web.calls.length = 0;
    await expect(bridge.postText(DM1, '')).resolves.toEqual({ ts: [] });
    expect(web.calls).toEqual([]);
  });

  it('updateText は blocks を空にして escapeMrkdwn した text で更新する', async () => {
    const { bridge, web } = makeBridge();
    await bridge.init();
    web.calls.length = 0;
    await bridge.updateText(DM1, '1.0', '<b> & <!here>');
    expect(web.calls[0]?.method).toBe('chat.update');
    expect(web.calls[0]?.args.blocks).toEqual([]);
    expect(web.calls[0]?.args.text).toBe('&lt;b&gt; &amp; @​here');
  });

  it('postToAll は失敗したチャンネルを結果から除いて続行する', async () => {
    const { bridge, web, logger } = makeBridge();
    const errorSpy = vi.spyOn(logger, 'error');
    await bridge.init();
    const original = web.chat.postMessage;
    web.chat.postMessage = async (args) => {
      if (args.channel === DM1) throw platformError('channel_not_found');
      return original(args);
    };
    const res = await bridge.postToAll('hello');
    expect(res).toEqual([{ channel: DM2, ts: '100.1' }]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('init は conversations.open が channel.id を返さないユーザーを飛ばす', async () => {
    const { bridge, web, logger } = makeBridge();
    const warnSpy = vi.spyOn(logger, 'warn');
    web.conversations.open = async (args) =>
      args.users === 'U111AAA' ? { ok: true } : { ok: true, channel: { id: DM2 } };
    const res = await bridge.init();
    expect(res.dmChannelCount).toBe(1);
    expect(bridge.allowedDmChannels.has(DM1)).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('init は DM を 1 件も開けなければ Error', async () => {
    const { bridge, web } = makeBridge();
    web.conversations.open = async () => {
      throw platformError('user_not_found');
    };
    await expect(bridge.init()).rejects.toThrow(/1 件も/);
  });

  it('init は team_id が無ければ Error（enterprise_id では代用しない）', async () => {
    const { bridge, web } = makeBridge();
    web.auth.test = async () => ({ ok: true, user_id: BOT });
    await expect(bridge.init()).rejects.toThrow(/team_id/);
  });

  it('init は user_id が無ければ Error', async () => {
    const { bridge, web } = makeBridge();
    web.auth.test = async () => ({ ok: true, team_id: 'T123ABC' });
    await expect(bridge.init()).rejects.toThrow(/user_id/);
  });
});
