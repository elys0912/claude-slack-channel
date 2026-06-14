// Slack（偽物の Web API / Socket Mode）と MCP（in-memory トランスポート + Client）を
// 実物の SlackBridge / ChannelServer / PermissionRelay でつないだ往復の統合テスト。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SlackBridge } from '../src/slack.js';
import { Logger } from '../src/log.js';
import { REACTION, createDegradedDeps, createToolHandlers, startBridgeApp, startDegradedApp } from '../src/app.js';
import { ChannelServer } from '../src/mcp.js';
import { ACCESS, DM1, DM2, flush, makeSocket, makeWeb, platformError } from './helpers/fake-slack.js';
import type { FakeSocket, FakeWeb } from './helpers/fake-slack.js';

interface Notification {
  method: string;
  params?: Record<string, unknown>;
}

interface Harness {
  web: FakeWeb;
  socket: FakeSocket;
  logger: Logger;
  client: Client;
  notifications: Notification[];
  stop: () => Promise<void>;
  lockReleased: number;
  order: string[];
}

async function startHarness(): Promise<Harness> {
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
  await bridge.init();
  web.calls.length = 0;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
  const notifications: Notification[] = [];
  client.fallbackNotificationHandler = async (n) => {
    notifications.push(n as Notification);
  };

  const harness: Harness = {
    web,
    socket,
    logger,
    client,
    notifications,
    stop: async () => undefined,
    lockReleased: 0,
    order: [],
  };

  const originalStop = bridge.stop.bind(bridge);
  vi.spyOn(bridge, 'stop').mockImplementation(async () => {
    harness.order.push('bridge.stop');
    await originalStop();
  });
  const lock = {
    release: () => {
      harness.lockReleased += 1;
      harness.order.push('lock.release');
    },
  };

  const app = await startBridgeApp({ bridge, logger, transport: serverTransport, lock });
  await client.connect(clientTransport);
  harness.stop = app.stop;
  return harness;
}

function dmEnvelope(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'events_api',
    envelope_id: 'env-1',
    body: {
      team_id: 'T123ABC',
      event_id: `Ev-${Math.random()}`,
      event: {
        type: 'message',
        channel_type: 'im',
        channel: DM1,
        user: 'U111AAA',
        text,
        ts: '10.1',
        ...overrides,
      },
    },
    ack: async () => undefined,
  };
}

function blockAction(actionId: string, value: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'interactive',
    body: {
      type: 'block_actions',
      team: { id: 'T123ABC' },
      user: { id: 'U111AAA' },
      channel: { id: DM1 },
      container: { message_ts: '55.5' },
      actions: [{ action_id: actionId, value }],
      ...overrides,
    },
    ack: async () => undefined,
  };
}

async function sendPermissionRequest(client: Client, requestId = 'abcde', inputPreview = '{"command":"ls"}'): Promise<void> {
  await client.notification({
    method: 'notifications/claude/channel/permission_request',
    params: {
      request_id: requestId,
      tool_name: 'Bash',
      description: 'Run shell command',
      input_preview: inputPreview,
    },
  });
  await flush();
}

describe('app.ts は import 時に副作用を持たない', () => {
  it('process のリスナーを増やさず、状態ディレクトリに何も書かない', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-import-'));
    const prevEnv = process.env.SLACK_CHANNEL_STATE_DIR;
    process.env.SLACK_CHANNEL_STATE_DIR = dir;
    const before = {
      unhandledRejection: process.listenerCount('unhandledRejection'),
      uncaughtException: process.listenerCount('uncaughtException'),
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    };
    try {
      const mod = await import('../src/app.js');
      expect(typeof mod.startBridgeApp).toBe('function');
      expect(process.listenerCount('unhandledRejection')).toBe(before.unhandledRejection);
      expect(process.listenerCount('uncaughtException')).toBe(before.uncaughtException);
      expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
      expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      if (prevEnv === undefined) delete process.env.SLACK_CHANNEL_STATE_DIR;
      else process.env.SLACK_CHANNEL_STATE_DIR = prevEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Slack → MCP', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await h.client.close();
    await h.stop();
  });

  it('DM が notifications/claude/channel として届き、その後 eyes リアクションが付く', async () => {
    h.socket.emit('slack_event', dmEnvelope('hello'));
    await flush();

    const n = h.notifications.find((x) => x.method === 'notifications/claude/channel');
    expect(n?.params?.content).toBe('hello');
    expect(n?.params?.meta).toEqual({
      chat_id: DM1,
      message_id: '10.1',
      thread_ts: '10.1',
      user_id: 'U111AAA',
      ts: '10.1',
    });
    const reactions = h.web.calls.filter((c) => c.method === 'reactions.add');
    expect(reactions).toEqual([{ method: 'reactions.add', args: { channel: DM1, timestamp: '10.1', name: REACTION.SEEN } }]);
  });

  it('許可外ユーザーの DM は何も起きない', async () => {
    h.socket.emit('slack_event', dmEnvelope('hello', { user: 'U999ZZZ' }));
    await flush();
    expect(h.notifications).toEqual([]);
    expect(h.web.calls).toEqual([]);
  });

  it('permission_request が全 DM に配信され、"yes ID" で verdict が返り、リアクションと書き換えが行われる', async () => {
    await sendPermissionRequest(h.client);

    const posts = h.web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts.map((p) => p.args.channel)).toEqual([DM1, DM2]);
    expect(posts[0]?.args.blocks).toBeDefined();
    expect(String(posts[0]?.args.text)).toContain('Bash');
    h.web.calls.length = 0;

    h.socket.emit('slack_event', dmEnvelope('yes ABCDE'));
    await flush();

    const verdict = h.notifications.find((x) => x.method === 'notifications/claude/channel/permission');
    expect(verdict?.params).toEqual({ request_id: 'abcde', behavior: 'allow' });
    // 通常のメッセージとしては届かない
    expect(h.notifications.some((x) => x.method === 'notifications/claude/channel')).toBe(false);

    const updates = h.web.calls.filter((c) => c.method === 'chat.update');
    expect(updates.map((u) => [u.args.channel, u.args.ts])).toEqual([
      [DM1, '100.1'],
      [DM2, '100.2'],
    ]);
    expect(String(updates[0]?.args.text)).toContain('Allowed');

    const reactions = h.web.calls.filter((c) => c.method === 'reactions.add');
    expect(reactions).toEqual([{ method: 'reactions.add', args: { channel: DM1, timestamp: '10.1', name: REACTION.ALLOW } }]);
    // verdict の送信 → 書き換え → リアクションの順
    const methods = h.web.calls.map((c) => c.method);
    expect(methods).toEqual(['chat.update', 'chat.update', 'reactions.add']);
  });

  it('"no ID" は deny の verdict と x リアクションになる', async () => {
    await sendPermissionRequest(h.client);
    h.web.calls.length = 0;

    h.socket.emit('slack_event', dmEnvelope('no abcde'));
    await flush();

    const verdict = h.notifications.find((x) => x.method === 'notifications/claude/channel/permission');
    expect(verdict?.params).toEqual({ request_id: 'abcde', behavior: 'deny' });
    const reactions = h.web.calls.filter((c) => c.method === 'reactions.add');
    expect(reactions[0]?.args.name).toBe(REACTION.DENY);
    expect(String(h.web.calls.find((c) => c.method === 'chat.update')?.args.text)).toContain('Denied');
  });

  it('記録のない ID への "yes" も verdict として送られ、リアクションが付く（現状固定）', async () => {
    h.socket.emit('slack_event', dmEnvelope('yes zzzzz'));
    await flush();

    const verdict = h.notifications.find((x) => x.method === 'notifications/claude/channel/permission');
    expect(verdict?.params).toEqual({ request_id: 'zzzzz', behavior: 'allow' });
    expect(h.web.calls.map((c) => c.method)).toEqual(['reactions.add']);
  });

  it('permission_request は直前に受信したスレッドに投稿される', async () => {
    h.socket.emit('slack_event', dmEnvelope('hello', { ts: '20.1', thread_ts: '20.0' }));
    await flush();
    h.web.calls.length = 0;

    await sendPermissionRequest(h.client);
    const posts = h.web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts[0]?.args.channel).toBe(DM1);
    expect(posts[0]?.args.thread_ts).toBe('20.0');
    expect(posts[1]?.args.channel).toBe(DM2);
    expect(posts[1]?.args).not.toHaveProperty('thread_ts');
  });

  it('Allow ボタンで verdict が返り、押されたメッセージが書き換わる', async () => {
    await sendPermissionRequest(h.client);
    h.web.calls.length = 0;

    h.socket.emit('interactive', blockAction('perm_allow', 'abcde', { container: { message_ts: '100.1' } }));
    await flush();

    const verdict = h.notifications.find((x) => x.method === 'notifications/claude/channel/permission');
    expect(verdict?.params).toEqual({ request_id: 'abcde', behavior: 'allow' });
    const updates = h.web.calls.filter((c) => c.method === 'chat.update');
    expect(updates).toHaveLength(2);
    expect(String(updates[0]?.args.text)).toContain('Allowed');
    // ボタンではリアクションは付けない
    expect(h.web.calls.some((c) => c.method === 'reactions.add')).toBe(false);
  });

  it('期限切れ（未登録）の Deny ボタンは Claude に送らず、押されたメッセージを expired 表示にする', async () => {
    h.socket.emit('interactive', blockAction('perm_deny', 'abcde'));
    await flush();

    expect(h.notifications.some((x) => x.method === 'notifications/claude/channel/permission')).toBe(false);
    const updates = h.web.calls.filter((c) => c.method === 'chat.update');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.args).toMatchObject({ channel: DM1, ts: '55.5' });
    expect(String(updates[0]?.args.text)).toContain('expired');
  });

  it('See more は container.message_ts のスレッドに input_preview 全文をブロックで送る', async () => {
    const preview = 'x'.repeat(5000);
    await sendPermissionRequest(h.client, 'abcde', preview);
    h.web.calls.length = 0;

    h.socket.emit('interactive', blockAction('perm_more', 'abcde', { container: { message_ts: '100.1' } }));
    await flush();

    const posts = h.web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.args.channel).toBe(DM1);
    expect(posts[0]?.args.thread_ts).toBe('100.1');
    expect(posts[0]?.args.text).toBe(preview);
    expect(posts[0]?.args.blocks).toEqual([
      { type: 'rich_text', elements: [{ type: 'rich_text_preformatted', elements: [{ type: 'text', text: preview }] }] },
    ]);
    // permission 自体は保留のまま
    expect(h.notifications.some((x) => x.method === 'notifications/claude/channel/permission')).toBe(false);
  });

  it('期限切れの See more は定型文をスレッドに送る', async () => {
    h.socket.emit('interactive', blockAction('perm_more', 'abcde'));
    await flush();

    const posts = h.web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.args.thread_ts).toBe('55.5');
    expect(posts[0]?.args.markdown_text).toBe('⌛ permission request abcde は既に期限切れ');
  });

  it('See more の送信に失敗しても warn だけで落ちない', async () => {
    const warnSpy = vi.spyOn(h.logger, 'warn');
    h.web.chat.postMessage = async () => {
      throw platformError('internal_error');
    };
    h.socket.emit('interactive', blockAction('perm_more', 'abcde'));
    await flush();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('see_more'))).toBe(true);
  });

  it('許可外チャンネルからのボタンは warn になり何も送らない', async () => {
    const warnSpy = vi.spyOn(h.logger, 'warn');
    h.socket.emit('interactive', blockAction('perm_allow', 'abcde', { channel: { id: 'D999ZZZ' } }));
    await flush();
    expect(warnSpy.mock.calls[0]?.[0]).toContain('channel_not_allowed');
    expect(h.web.calls).toEqual([]);
  });
});

describe('MCP → Slack', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await h.client.close();
    await h.stop();
  });

  it('reply は DM に投稿し "sent (N message(s))" を返す', async () => {
    const res = await h.client.callTool({ name: 'reply', arguments: { chat_id: DM1, text: 'hi', thread_ts: '10.1' } });
    expect(res.content).toEqual([{ type: 'text', text: 'sent (1 message(s))' }]);
    expect(res.isError).toBeFalsy();
    const posts = h.web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts).toEqual([
      { method: 'chat.postMessage', args: { channel: DM1, markdown_text: 'hi', thread_ts: '10.1' } },
    ]);
  });

  it('長い reply は分割され、件数が返る', async () => {
    const text = ('あ'.repeat(99) + '\n').repeat(300);
    const res = await h.client.callTool({ name: 'reply', arguments: { chat_id: DM1, text } });
    const posts = h.web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts.length).toBeGreaterThan(1);
    expect(res.content).toEqual([{ type: 'text', text: `sent (${posts.length} message(s))` }]);
  });

  it('許可外チャンネルへの reply は "error: ..." を返し、isError にはしない', async () => {
    const errorSpy = vi.spyOn(h.logger, 'error');
    const res = await h.client.callTool({ name: 'reply', arguments: { chat_id: 'D999ZZZ', text: 'hi' } });
    expect(res.content).toEqual([{ type: 'text', text: 'error: 許可されていない送信先チャンネル' }]);
    expect(res.isError).toBeFalsy();
    expect(errorSpy.mock.calls[0]?.[0]).toBe('reply に失敗');
  });

  it('Slack API のエラーも "error: <message>" として返る', async () => {
    h.web.chat.postMessage = async () => {
      throw platformError('channel_not_found');
    };
    const res = await h.client.callTool({ name: 'reply', arguments: { chat_id: DM1, text: 'hi' } });
    expect(res.content).toEqual([{ type: 'text', text: 'error: An API error occurred: channel_not_found' }]);
  });

  it('react はコロンを外してリアクションを付ける', async () => {
    const res = await h.client.callTool({ name: 'react', arguments: { chat_id: DM1, message_id: '10.1', emoji: ':eyes:' } });
    expect(res.content).toEqual([{ type: 'text', text: 'reacted' }]);
    expect(h.web.calls).toEqual([{ method: 'reactions.add', args: { channel: DM1, timestamp: '10.1', name: 'eyes' } }]);
  });

  it('react は reactions.add の失敗（already_reacted）でも reacted を返す', async () => {
    h.web.reactionError = platformError('already_reacted');
    const res = await h.client.callTool({ name: 'react', arguments: { chat_id: DM1, message_id: '10.1', emoji: 'eyes' } });
    expect(res.content).toEqual([{ type: 'text', text: 'reacted' }]);
  });

  it('edit_message は blocks を外して本文を書き換える', async () => {
    const res = await h.client.callTool({ name: 'edit_message', arguments: { chat_id: DM1, message_id: '10.1', text: 'new <b>' } });
    expect(res.content).toEqual([{ type: 'text', text: 'edited' }]);
    expect(h.web.calls).toEqual([
      { method: 'chat.update', args: { channel: DM1, ts: '10.1', text: 'new &lt;b&gt;', blocks: [] } },
    ]);
  });

  it('引数不足は isError', async () => {
    const res = await h.client.callTool({ name: 'reply', arguments: { chat_id: DM1 } });
    expect(res.isError).toBe(true);
  });
});

describe('停止', () => {
  it('stop は bridge.stop → server.close → lock.release の順', async () => {
    const h = await startHarness();
    await h.client.close();
    await h.stop();
    expect(h.order).toEqual(['bridge.stop', 'lock.release']);
    expect(h.socket.disconnected).toBe(1);
    expect(h.lockReleased).toBe(1);
  });

  it('startBridgeApp は Socket Mode を 1 回だけ開始する', async () => {
    const h = await startHarness();
    expect(h.socket.started).toBe(1);
    await h.client.close();
    await h.stop();
    expect(h.socket.started).toBe(1);
  });
});

describe('縮退モード', () => {
  it('ツールはすべて error 文を返し、permission_request は warn で無視する', async () => {
    const logger = new Logger({ stderr: false });
    const warnSpy = vi.spyOn(logger, 'warn');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
    const app = await startDegradedApp({ logger, transport: serverTransport });
    await client.connect(clientTransport);

    const busy = 'error: 別のインスタンスが動いているため、この Slack ブリッジは送信できない';
    const reply = await client.callTool({ name: 'reply', arguments: { chat_id: DM1, text: 'hi' } });
    expect(reply.content).toEqual([{ type: 'text', text: busy }]);
    const react = await client.callTool({ name: 'react', arguments: { chat_id: DM1, message_id: '1', emoji: 'eyes' } });
    expect(react.content).toEqual([{ type: 'text', text: busy }]);
    const edit = await client.callTool({ name: 'edit_message', arguments: { chat_id: DM1, message_id: '1', text: 'x' } });
    expect(edit.content).toEqual([{ type: 'text', text: busy }]);

    await sendPermissionRequest(client);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('縮退モード');

    await client.close();
    await app.stop();
  });

  it('createDegradedDeps は logger をそのまま含む', async () => {
    const logger = new Logger({ stderr: false });
    const deps = createDegradedDeps(logger);
    expect(deps.logger).toBe(logger);
    expect(await deps.onReply({ chat_id: DM1, text: 'x' })).toMatch(/^error: /);
    // ChannelServer にそのまま渡せる
    expect(() => new ChannelServer(deps)).not.toThrow();
  });
});

describe('createToolHandlers 単体', () => {
  it('bridge の例外を error 文にして返し、logger.error に残す', async () => {
    const logger = new Logger({ stderr: false });
    const errorSpy = vi.spyOn(logger, 'error');
    const handlers = createToolHandlers(
      {
        postText: async () => {
          throw new Error('boom');
        },
        addReaction: async () => undefined,
        updateText: async () => {
          throw 'not-an-error';
        },
      },
      logger
    );
    expect(await handlers.onReply({ chat_id: DM1, text: 'x' })).toBe('error: boom');
    expect(await handlers.onEdit({ chat_id: DM1, message_id: '1', text: 'x' })).toBe('error: not-an-error');
    expect(await handlers.onReact({ chat_id: DM1, message_id: '1', emoji: ':+1:' })).toBe('reacted');
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});
