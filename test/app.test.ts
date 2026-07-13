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
import {
  REACTION,
  createDegradedDeps,
  createToolHandlers,
  fencePreview,
  startBridgeApp,
  startDegradedApp,
} from '../src/app.js';
import { ChannelServer } from '../src/mcp.js';
import { PermissionRelay } from '../src/permission-relay.js';
import { ACCESS, BOT, DM1, DM2, flush, makeSocket, makeWeb, platformError } from './helpers/fake-slack.js';
import type { FakeSocket, FakeWeb } from './helpers/fake-slack.js';
import type { ParsedAccess } from '../src/config.js';
import type { BridgeAppOptions } from '../src/app.js';
import type { ConsoleKey } from '../src/console.js';

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

async function startHarness(
  access: ParsedAccess = ACCESS,
  replyTimeoutMs?: number,
  extra: Pick<
    BridgeAppOptions,
    'console' | 'allowExtraFile' | 'denyFiles' | 'home' | 'hookInboxFile' | 'hookPollMs' | 'restartFlagFile' | 'killParent'
  > = {}
): Promise<Harness> {
  const web = makeWeb();
  const socket = makeSocket();
  const logger = new Logger({ stderr: false });
  const bridge = new SlackBridge({
    botToken: 'xoxb-TEST-DUMMY',
    appToken: 'xapp-TEST-DUMMY',
    access,
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

  const app = await startBridgeApp({ bridge, logger, transport: serverTransport, lock, replyTimeoutMs, ...extra });
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

  it('記録のない ID への "yes" は verdict にせず、通常のメッセージとして届ける', async () => {
    await sendPermissionRequest(h.client);
    h.web.calls.length = 0;

    h.socket.emit('slack_event', dmEnvelope('yes maybe'));
    await flush();

    expect(h.notifications.some((x) => x.method === 'notifications/claude/channel/permission')).toBe(false);
    const n = h.notifications.find((x) => x.method === 'notifications/claude/channel');
    expect(n?.params?.content).toBe('yes maybe');
    expect(h.web.calls).toEqual([{ method: 'reactions.add', args: { channel: DM1, timestamp: '10.1', name: REACTION.SEEN } }]);
  });

  it('permission_request は直前に受信したスレッドにだけ返信される', async () => {
    h.socket.emit('slack_event', dmEnvelope('hello', { ts: '20.1', thread_ts: '20.0' }));
    await flush();
    h.web.calls.length = 0;

    await sendPermissionRequest(h.client);
    const posts = h.web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.args.channel).toBe(DM1);
    expect(posts[0]?.args.thread_ts).toBe('20.0');
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

  it('See more はスレッド外のボタンなら container.message_ts を起点に、input_preview 全文をコードブロックで送る', async () => {
    const preview = 'x'.repeat(5000);
    await sendPermissionRequest(h.client, 'abcde', preview);
    h.web.calls.length = 0;

    h.socket.emit('interactive', blockAction('perm_more', 'abcde', { container: { message_ts: '100.1' } }));
    await flush();

    const posts = h.web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.args.channel).toBe(DM1);
    expect(posts[0]?.args.thread_ts).toBe('100.1');
    expect(posts[0]?.args.markdown_text).toBe('```\n' + preview + '\n```');
    expect(posts[0]?.args.blocks).toBeUndefined();
    // permission 自体は保留のまま
    expect(h.notifications.some((x) => x.method === 'notifications/claude/channel/permission')).toBe(false);
  });

  it('See more はスレッド内のボタンならスレッドの親に送り、長い全文はコードブロックを保って分割する', async () => {
    const preview = ('y'.repeat(99) + '\n').repeat(300);
    await sendPermissionRequest(h.client, 'abcde', preview);
    h.web.calls.length = 0;

    h.socket.emit(
      'interactive',
      blockAction('perm_more', 'abcde', { container: { message_ts: '100.1', thread_ts: '20.0' } })
    );
    await flush();

    const posts = h.web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts.length).toBeGreaterThan(1);
    for (const p of posts) {
      expect(p.args.thread_ts).toBe('20.0');
      const body = String(p.args.markdown_text);
      expect(body.startsWith('```\n')).toBe(true);
      expect(body.endsWith('\n```')).toBe(true);
    }
  });

  it('See more の全文でも双方向制御文字・ゼロ幅文字を \\u{XXXX} の形で見せる', async () => {
    await sendPermissionRequest(h.client, 'abcde', 'rm -rf \u202e/ \u200bok');
    h.web.calls.length = 0;

    h.socket.emit('interactive', blockAction('perm_more', 'abcde', { container: { message_ts: '100.1' } }));
    await flush();

    const posts = h.web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts[0]?.args.markdown_text).toBe('```\nrm -rf \\u{202E}/ \\u{200B}ok\n```');
  });

  it('fencePreview は中身の行頭の ``` を無効化してからコードブロックで包む', () => {
    expect(fencePreview('a\n```js\nb\n```')).toBe('```\na\n\u200b```js\nb\n\u200b```\n```');
  });

  it('期限切れの See more は定型文をスレッドに送る', async () => {
    h.socket.emit('interactive', blockAction('perm_more', 'abcde'));
    await flush();

    const posts = h.web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.args.thread_ts).toBe('55.5');
    expect(posts[0]?.args.markdown_text).toBe('⌛ permission request abcde は既に期限切れ');
  });

  it('期限切れの See more もスレッド内のボタンならスレッドの親に送る', async () => {
    h.socket.emit('interactive', blockAction('perm_more', 'abcde', { container: { message_ts: '55.5', thread_ts: '20.0' } }));
    await flush();

    const posts = h.web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts[0]?.args.thread_ts).toBe('20.0');
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
      {
        method: 'chat.postMessage',
        args: { channel: DM1, markdown_text: 'hi', thread_ts: '10.1', unfurl_links: false, unfurl_media: false },
      },
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

  it('長い reply が途中で失敗したら、送れた件数を error 文に含める', async () => {
    const original = h.web.chat.postMessage;
    let n = 0;
    h.web.chat.postMessage = async (args) => {
      n += 1;
      if (n === 3) throw platformError('internal_error');
      return original(args);
    };
    const text = ('あ'.repeat(99) + '\n').repeat(300);
    const res = await h.client.callTool({ name: 'reply', arguments: { chat_id: DM1, text } });
    expect(res.content).toEqual([{ type: 'text', text: 'error: An API error occurred: internal_error (sent=2)' }]);
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** ChannelServer.close の呼び出しを order に記録する */
  function recordServerClose(order: string[]): void {
    const originalClose = ChannelServer.prototype.close;
    vi.spyOn(ChannelServer.prototype, 'close').mockImplementation(async function (this: ChannelServer) {
      order.push('server.close');
      return originalClose.call(this);
    });
  }

  it('stop は lock.release → relay.denyAll → bridge.stop → server.close の順で、2 回呼んでも 1 回だけ片付ける', async () => {
    const order: string[] = [];
    recordServerClose(order);
    const h = await startHarness();
    const originalDenyAll = PermissionRelay.prototype.denyAll;
    vi.spyOn(PermissionRelay.prototype, 'denyAll').mockImplementation(async function (this: PermissionRelay, reason) {
      h.order.push('relay.denyAll');
      return originalDenyAll.call(this, reason);
    });
    await h.client.close();
    order.length = 0;
    h.order.length = 0;
    await h.stop();
    await h.stop();
    expect([...h.order, ...order]).toEqual(['lock.release', 'relay.denyAll', 'bridge.stop', 'server.close']);
    expect(h.socket.disconnected).toBe(1);
    expect(h.lockReleased).toBe(1);
  });

  it('stop は保留中の permission request に deny を返し、Slack のメッセージを書き換えてから切断する', async () => {
    const h = await startHarness();
    await sendPermissionRequest(h.client);
    h.web.calls.length = 0;

    await h.stop();
    await flush();

    const verdicts = h.notifications.filter((x) => x.method === 'notifications/claude/channel/permission');
    expect(verdicts.map((v) => v.params)).toEqual([{ request_id: 'abcde', behavior: 'deny' }]);
    const updates = h.web.calls.filter((c) => c.method === 'chat.update');
    expect(updates.map((u) => [u.args.channel, u.args.ts])).toEqual([
      [DM1, '100.1'],
      [DM2, '100.2'],
    ]);
    expect(String(updates[0]?.args.text)).toContain('自動で拒否した');
    await h.client.close();
  });

  it('Socket Mode の開始に失敗したら、後片付けしてから投げる。後片付けの関数は start より前に渡される', async () => {
    const order: string[] = [];
    recordServerClose(order);
    const web = makeWeb();
    const socket = makeSocket();
    const logger = new Logger({ stderr: false });
    const bridge = new SlackBridge({ botToken: 'xoxb-TEST-DUMMY', appToken: 'xapp-TEST-DUMMY', access: ACCESS, logger, web, socket });
    await bridge.init();
    socket.failStart = ['auth'];
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const lock = { release: () => void order.push('lock.release') };
    let startedWhenReady: number | undefined;

    await expect(
      startBridgeApp({
        bridge,
        logger,
        transport: serverTransport,
        lock,
        onCleanupReady: () => {
          startedWhenReady = socket.started;
        },
      })
    ).rejects.toThrow(/internal_error/);
    expect(startedWhenReady).toBe(0);
    expect(order).toEqual(['lock.release', 'server.close']);
    expect(socket.disconnected).toBe(1);
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

describe('チャンネル（access.channels）', () => {
  const CH = 'C333CCC';
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness({ ...ACCESS, channels: [CH] });
  });

  afterEach(async () => {
    await h.client.close();
    await h.stop();
  });

  /** チャンネルの投稿。既定ではボットへのメンションを付ける（mention: false で付けない） */
  function channelEnvelope(
    text: string,
    overrides: Record<string, unknown> = {},
    mention = true
  ): Record<string, unknown> {
    return dmEnvelope(mention ? `<@${BOT}> ${text}` : text, { channel_type: 'channel', channel: CH, ...overrides });
  }

  const delivered = () =>
    h.notifications.filter((x) => x.method === 'notifications/claude/channel').map((x) => x.params?.content);

  it('メンションの無い投稿には反応しない（リアクションも付けない）', async () => {
    h.socket.emit('slack_event', channelEnvelope('just chatting', { ts: '31.1' }, false));
    await flush();
    expect(delivered()).toEqual([]);
    expect(h.web.calls).toEqual([]);
  });

  it('メンションで話しかけたスレッドの続きは、メンション無しでも届く。関係ないスレッドは届かない', async () => {
    h.socket.emit('slack_event', channelEnvelope('start', { ts: '32.0' }));
    h.socket.emit('slack_event', channelEnvelope('follow up', { ts: '32.1', thread_ts: '32.0' }, false));
    h.socket.emit('slack_event', channelEnvelope('other thread', { ts: '33.1', thread_ts: '33.0' }, false));
    await flush();
    expect(delivered()).toEqual(['start', 'follow up']);
  });

  it('ボットが投稿したスレッドへの返信は、メンション無しでも届く', async () => {
    const res = await h.client.callTool({ name: 'reply', arguments: { chat_id: CH, text: 'お知らせ' } });
    expect(res.isError).toBeFalsy();
    // 偽の Slack は投稿ごとに 100.1, 100.2, ... と ts を振る。この describe では最初の投稿
    expect(h.web.calls.filter((c) => c.method === 'chat.postMessage')).toHaveLength(1);

    h.socket.emit('slack_event', channelEnvelope('返信', { ts: '34.1', thread_ts: '100.1' }, false));
    await flush();
    expect(delivered()).toEqual(['返信']);
  });

  it('許可チャンネルの投稿が Claude に届き、同じチャンネルに返信・リアクションできる', async () => {
    h.socket.emit('slack_event', channelEnvelope('hello', { ts: '30.1' }));
    await flush();

    const n = h.notifications.find((x) => x.method === 'notifications/claude/channel');
    expect(n?.params?.meta).toMatchObject({ chat_id: CH, thread_ts: '30.1' });
    expect(h.web.calls).toEqual([{ method: 'reactions.add', args: { channel: CH, timestamp: '30.1', name: REACTION.SEEN } }]);

    const res = await h.client.callTool({ name: 'reply', arguments: { chat_id: CH, text: 'hi', thread_ts: '30.1' } });
    expect(res.content).toEqual([{ type: 'text', text: 'sent (1 message(s))' }]);
  });

  it('非公開チャンネル（group）も受け付け、許可外のチャンネルと許可外ユーザーは無視する', async () => {
    h.socket.emit('slack_event', channelEnvelope('private', { channel_type: 'group' }));
    h.socket.emit('slack_event', channelEnvelope('other', { channel: 'C999ZZZ' }));
    h.socket.emit('slack_event', channelEnvelope('stranger', { user: 'U999ZZZ' }));
    await flush();

    const delivered = h.notifications.filter((x) => x.method === 'notifications/claude/channel');
    expect(delivered.map((x) => x.params?.content)).toEqual(['private']);
  });

  it('permission_request はチャンネルのスレッドに返信され、そのボタンで回答できる', async () => {
    h.socket.emit('slack_event', channelEnvelope('do it', { ts: '30.2', thread_ts: '30.0' }));
    await flush();
    h.web.calls.length = 0;

    await sendPermissionRequest(h.client);
    const posts = h.web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.args).toMatchObject({ channel: CH, thread_ts: '30.0' });
    h.web.calls.length = 0;

    h.socket.emit(
      'interactive',
      blockAction('perm_allow', 'abcde', { channel: { id: CH }, container: { message_ts: '100.1' } })
    );
    await flush();

    const verdict = h.notifications.find((x) => x.method === 'notifications/claude/channel/permission');
    expect(verdict?.params).toEqual({ request_id: 'abcde', behavior: 'allow' });
    const updates = h.web.calls.filter((c) => c.method === 'chat.update');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.args.channel).toBe(CH);
  });

  it('チャンネルの受信で、そのチャンネルを DM として覚えない（DM への配信先が変わらない）', async () => {
    h.socket.emit('slack_event', channelEnvelope('hello'));
    await flush();
    h.web.calls.length = 0;

    // 直前がチャンネルのスレッドなので、返信が失敗したときの DM 配信先を確かめる
    h.web.chat.postMessage = async (args) => {
      h.web.calls.push({ method: 'chat.postMessage', args });
      if (args.channel === CH) throw platformError('not_in_channel');
      return { ok: true, ts: '200.1' };
    };
    await sendPermissionRequest(h.client);
    const posts = h.web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts.map((p) => p.args.channel)).toEqual([CH, DM1, DM2]);
  });
});

describe('無応答の見張り（replyTimeoutMs）', () => {
  let h: Harness;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const warnings = () =>
    h.web.calls.filter((c) => c.method === 'chat.postMessage' && String(c.args.text).includes('応答が無い'));

  beforeEach(async () => {
    h = await startHarness(ACCESS, 60);
  });

  afterEach(async () => {
    await h.client.close();
    await h.stop();
  });

  it('Claude が何も返さないまま待ち時間を過ぎたら、そのスレッドに警告を投稿する', async () => {
    h.socket.emit('slack_event', dmEnvelope('hello', { ts: '40.1', thread_ts: '40.0' }));
    await flush();
    await wait(120);

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.args).toMatchObject({ channel: DM1, thread_ts: '40.0' });
  });

  it('待ち時間内に reply があれば警告しない', async () => {
    h.socket.emit('slack_event', dmEnvelope('hello', { ts: '40.1' }));
    await flush();
    await h.client.callTool({ name: 'reply', arguments: { chat_id: DM1, text: 'ok', thread_ts: '40.1' } });
    await wait(120);

    expect(warnings()).toHaveLength(0);
  });

  it('待ち時間内に permission_request が来れば警告しない', async () => {
    h.socket.emit('slack_event', dmEnvelope('hello', { ts: '40.1' }));
    await flush();
    await sendPermissionRequest(h.client);
    await wait(120);

    expect(warnings()).toHaveLength(0);
  });
});

describe('ターミナル画面と許可リスト（!screen / 今後も許可 / !rules）', () => {
  const CHROME = [
    ' Claude wants to use your browser',
    '    Install extension  Opens the install page in Chrome',
    '  > Not now            Continue without browser tools',
    "    Don't ask again    Revisit anytime with /chrome",
  ].join('\n');
  let h: Harness;
  let dir: string;
  let sent: ConsoleKey[][];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-rules-'));
    const denyFile = path.join(dir, 'settings.json');
    fs.writeFileSync(denyFile, JSON.stringify({ permissions: { deny: ['Bash(git log --all:*)'] } }));
    sent = [];
    h = await startHarness(ACCESS, undefined, {
      console: { read: async () => CHROME, sendKeys: async (keys) => void sent.push(keys), sendCommand: async () => undefined },
      allowExtraFile: path.join(dir, 'allow-extra.json'),
      denyFiles: [denyFile],
    });
  });

  afterEach(async () => {
    await h.client.close();
    await h.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const posts = () => h.web.calls.filter((c) => c.method === 'chat.postMessage');

  it('!screen は Claude に渡さず、選択肢のボタンを出し、押すと選択キーを送る', async () => {
    h.socket.emit('slack_event', dmEnvelope('!screen', { ts: '50.1' }));
    await flush();

    expect(h.notifications.filter((x) => x.method === 'notifications/claude/channel')).toEqual([]);
    const blocks = posts()[0]?.args.blocks as { type: string; elements?: { action_id: string; value: string }[] }[];
    const pick = blocks.find((b) => b.type === 'actions')?.elements?.[2];
    expect(pick?.action_id).toBe('screen_pick_2');

    h.socket.emit(
      'interactive',
      blockAction(pick?.action_id ?? '', pick?.value ?? '', { container: { message_ts: '100.1', thread_ts: '50.1' } })
    );
    await flush();
    await flush();
    expect(sent).toEqual([['Down', 'Enter']]);
  });

  it('今後も許可: 今回は許可し、確認のうえ allow-extra.json に書き込む', async () => {
    await client_sendBash(h, 'git status');
    h.web.calls.length = 0;

    h.socket.emit('interactive', blockAction('perm_always', 'abcde', { container: { message_ts: '100.1' } }));
    await flush();
    await flush();

    const verdict = h.notifications.find((x) => x.method === 'notifications/claude/channel/permission');
    expect(verdict?.params).toEqual({ request_id: 'abcde', behavior: 'allow' });
    const proposal = posts().find((p) => String(p.args.text).includes('Bash(git status:*)'));
    const add = (proposal?.args.blocks as { type: string; elements?: { action_id: string; value: string }[] }[])
      .find((b) => b.type === 'actions')
      ?.elements?.find((e) => e.action_id === 'rule_add');

    h.socket.emit('interactive', blockAction('rule_add', add?.value ?? '', { container: { message_ts: '100.2' } }));
    await flush();
    await flush();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'allow-extra.json'), 'utf8'))).toEqual({ allow: ['Bash(git status:*)'] });
  });

  it('今後も許可: deny に当たるなら、今回は許可したうえで追加しない旨と当たった deny を知らせる', async () => {
    // 候補は Bash(git log:*)。deny の Bash(git log --all:*) と範囲が重なる
    await client_sendBash(h, 'git log -1');
    h.web.calls.length = 0;

    h.socket.emit('interactive', blockAction('perm_always', 'abcde', { container: { message_ts: '100.1' } }));
    await flush();
    await flush();

    const verdict = h.notifications.find((x) => x.method === 'notifications/claude/channel/permission');
    expect(verdict?.params).toEqual({ request_id: 'abcde', behavior: 'allow' });
    const notice = posts().find((p) => String(p.args.markdown_text).includes('deny に当たる'));
    expect(String(notice?.args.markdown_text)).toContain('Bash(git log --all:*)');
    expect(fs.existsSync(path.join(dir, 'allow-extra.json'))).toBe(false);
  });

  it('!rules で追加分を一覧できる', async () => {
    fs.writeFileSync(path.join(dir, 'allow-extra.json'), JSON.stringify({ allow: ['WebFetch'] }));
    h.socket.emit('slack_event', dmEnvelope('!rules', { ts: '60.1' }));
    await flush();
    expect(String(posts()[0]?.args.text)).toContain('1 件');
  });
});

/** Bash の permission_request を Claude 側から送る */
async function client_sendBash(h: Harness, command: string): Promise<void> {
  await h.client.notification({
    method: 'notifications/claude/channel/permission_request',
    params: {
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'run',
      input_preview: JSON.stringify({ command }),
    },
  });
  await flush();
}

describe('ホームタブ', () => {
  let h: Harness;
  const home = { users: ACCESS.allowFrom, workDir: 'C:\\dev', channelCount: 0 };
  const publishes = () => h.web.calls.filter((c) => c.method === 'views.publish');

  function homeOpened(user: string, tab = 'home', team = 'T123ABC'): Record<string, unknown> {
    return {
      type: 'events_api',
      envelope_id: 'env-home',
      body: { team_id: team, event_id: `Ev-${Math.random()}`, event: { type: 'app_home_opened', user, tab } },
      ack: async () => undefined,
    };
  }

  beforeEach(async () => {
    // startHarness は起動前に web.calls を空にするので、起動時の publish は残る
    h = await startHarness(ACCESS, undefined, { home });
  });

  afterEach(async () => {
    await h.client.close();
    await h.stop();
  });

  it('起動したら許可ユーザー全員のホームを稼働中にする', () => {
    expect(publishes().map((p) => p.args.user_id)).toEqual(ACCESS.allowFrom);
    expect(JSON.stringify(publishes()[0]?.args.view)).toContain('稼働中');
  });

  it('ホームが開かれたら、許可ユーザーには状態を、それ以外には中身の無い画面を出す', async () => {
    h.web.calls.length = 0;
    h.socket.emit('slack_event', homeOpened('U111AAA'));
    h.socket.emit('slack_event', homeOpened('U999ZZZ'));
    await flush();

    expect(publishes().map((p) => p.args.user_id)).toEqual(['U111AAA', 'U999ZZZ']);
    expect(JSON.stringify(publishes()[0]?.args.view)).toContain('作業フォルダー');
    expect(JSON.stringify(publishes()[1]?.args.view)).not.toContain('作業フォルダー');
  });

  it('ホーム以外のタブ・別ワークスペースのイベントは無視する', async () => {
    h.web.calls.length = 0;
    h.socket.emit('slack_event', homeOpened('U111AAA', 'messages'));
    h.socket.emit('slack_event', homeOpened('U111AAA', 'home', 'TOTHER'));
    await flush();
    expect(publishes()).toEqual([]);
  });

  it('終了時に許可ユーザー全員のホームを停止中へ書き換える', async () => {
    h.web.calls.length = 0;
    await h.stop();
    expect(publishes().map((p) => p.args.user_id)).toEqual(ACCESS.allowFrom);
    expect(JSON.stringify(publishes()[0]?.args.view)).toContain('停止中');
  });
});

describe('!status / !restart / !compact', () => {
  const PROMPT = ['Claude: done.', '', '❯ ', '  ? for shortcuts'].join('\n');
  let h: Harness;
  let dir: string;
  let flag: string;
  let screen: string;
  let commands: string[];
  let killed: number;
  const posts = () => h.web.calls.filter((c) => c.method === 'chat.postMessage');
  const texts = () => posts().map((p) => String(p.args.markdown_text ?? p.args.text));

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-session-'));
    flag = path.join(dir, 'restart.flag');
    screen = PROMPT;
    commands = [];
    killed = 0;
    h = await startHarness(ACCESS, undefined, {
      console: { read: async () => screen, sendKeys: async () => undefined, sendCommand: async (c) => void commands.push(c) },
      restartFlagFile: flag,
      killParent: () => void killed++,
      home: { users: ACCESS.allowFrom, workDir: 'C:\\dev\\app', channelCount: 0 },
    });
    h.web.calls.length = 0;
  });

  afterEach(async () => {
    await h.client.close();
    await h.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('!status は Claude に渡さず、稼働状態をスレッドに返す', async () => {
    h.socket.emit('slack_event', dmEnvelope('!status', { ts: '80.1' }));
    await flush();

    expect(h.notifications.filter((x) => x.method === 'notifications/claude/channel')).toEqual([]);
    expect(posts()[0]?.args).toMatchObject({ channel: DM1, thread_ts: '80.1' });
    const text = texts()[0] ?? '';
    expect(text).toContain('ブリッジの状態');
    expect(text).toContain('C:\\dev\\app');
    expect(text).toContain('返事待ち: 無し');
    expect(text).toContain('実行許可: 0 件');
  });

  it('!restart は restart.flag を置いて /exit を送る', async () => {
    h.socket.emit('slack_event', dmEnvelope('!restart', { ts: '81.1' }));
    await flush();
    await flush();

    expect(fs.existsSync(flag)).toBe(true);
    expect(commands).toEqual(['exit']);
    expect(killed).toBe(0);
    expect(texts().join('\n')).toContain('/exit を送った');
  });

  it('入力待ちでなければ /exit を送らない（印は置いたまま）', async () => {
    screen = 'Thinking…\n⠋ Working';
    h.socket.emit('slack_event', dmEnvelope('!restart', { ts: '82.1' }));
    await flush();
    await flush();

    expect(commands).toEqual([]);
    expect(texts().join('\n')).toContain('入力待ちでない');
  });

  it('!restart force は印を置いて claude.exe を止める', async () => {
    h.socket.emit('slack_event', dmEnvelope('!restart  force', { ts: '83.1' }));
    await flush();
    await flush();

    expect(fs.existsSync(flag)).toBe(true);
    expect(killed).toBe(1);
    expect(commands).toEqual([]);
  });

  it('!compact は /compact を送り、印は置かない', async () => {
    h.socket.emit('slack_event', dmEnvelope('!compact', { ts: '84.1' }));
    await flush();
    await flush();

    expect(commands).toEqual(['compact']);
    expect(fs.existsSync(flag)).toBe(false);
  });
});

describe('hook の記録（hooks.jsonl）からの知らせ', () => {
  let h: Harness;
  let dir: string;
  let file: string;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const posts = () => h.web.calls.filter((c) => c.method === 'chat.postMessage');
  const hookLine = (fields: Record<string, unknown>) => JSON.stringify({ at: Date.now(), session_id: 's1', ...fields }) + '\n';

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-hooks-'));
    file = path.join(dir, 'hooks.jsonl');
    h = await startHarness(ACCESS, undefined, {
      hookInboxFile: file,
      hookPollMs: 20,
      console: { read: async () => '', sendKeys: async () => undefined, sendCommand: async () => undefined },
    });
  });

  afterEach(async () => {
    await h.client.close();
    await h.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ターミナル側の許可待ちは、画面を確認するボタン付きで許可ユーザー全員の DM に出す', async () => {
    fs.appendFileSync(file, hookLine({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs permission' }));
    await wait(60);

    expect(posts().map((p) => p.args.channel)).toEqual([DM1, DM2]);
    expect(String(posts()[0]?.args.text)).toContain('ターミナル側で入力待ち');
    const blocks = posts()[0]?.args.blocks as { type: string; elements?: { action_id: string }[] }[];
    expect(blocks.at(-1)?.elements?.[0]?.action_id).toBe('screen_show');
  });

  it('話しかけられた後は、そのスレッドに出す', async () => {
    h.socket.emit('slack_event', dmEnvelope('hello', { ts: '70.1' }));
    await flush();
    h.web.calls.length = 0;
    fs.appendFileSync(file, hookLine({ hook_event_name: 'StopFailure', error: 'rate_limit' }));
    await wait(60);

    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.args).toMatchObject({ channel: DM1, thread_ts: '70.1' });
    expect(String(posts()[0]?.args.text)).toContain('使用量の上限');
  });

  it('Slack に中継中の許可があるときは、ターミナル側の許可待ちを重ねて知らせない', async () => {
    await sendPermissionRequest(h.client);
    h.web.calls.length = 0;
    fs.appendFileSync(file, hookLine({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }));
    await wait(60);
    expect(posts()).toEqual([]);
  });

  it('Stop は Slack への返事が無いときだけ知らせる', async () => {
    fs.appendFileSync(file, hookLine({ hook_event_name: 'Stop' }));
    await wait(60);
    expect(posts()).toEqual([]);

    h.socket.emit('slack_event', dmEnvelope('hello', { ts: '71.1' }));
    await flush();
    h.web.calls.length = 0;
    fs.appendFileSync(file, hookLine({ hook_event_name: 'Stop' }));
    await wait(60);
    expect(posts()).toHaveLength(1);
    expect(String(posts()[0]?.args.text)).toContain('返事をしないまま');
  });
});
