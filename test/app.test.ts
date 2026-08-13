// Slack（偽物の Web API / Socket Mode）と MCP（in-memory トランスポート + Client）を
// 実物の SlackBridge / ChannelServer / PermissionRelay でつないだ往復の統合テスト。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Logger } from '../src/log.js';
import {
  KEEPALIVE_TEXT,
  REACTION,
  createDegradedDeps,
  createToolHandlers,
  parseCommand,
  fencePreview,
  startBridgeApp,
  startDegradedApp,
} from '../src/app.js';
import { ChannelServer } from '../src/mcp.js';
import { PermissionRelay } from '../src/permission-relay.js';
import {
  ACCESS,
  BOT,
  DM1,
  DM2,
  blockActionEnvelope,
  eventEnvelope,
  flush,
  makeBridge,
  makeSocket,
  makeWeb,
  messageEnvelope,
  platformError,
} from './helpers/fake-slack.js';
import { linkClient, notifyPermissionRequest } from './helpers/mcp-client.js';
import { actionsOf } from './helpers/block-kit.js';
import { CHROME_CHOICE_SCREEN } from './fixtures/screens.js';
import type { ApiCall, FakeSocket, FakeWeb } from './helpers/fake-slack.js';
import type { Notification, PermissionRequestParams } from './helpers/mcp-client.js';
import type { ParsedAccess } from '../src/config.js';
import type { BridgeAppOptions } from '../src/app.js';
import type { ConsoleKey } from '../src/console.js';

interface Harness {
  web: FakeWeb;
  socket: FakeSocket;
  logger: Logger;
  client: Client;
  notifications: Notification[];
  /** Claude に届いたメッセージ（notifications/claude/channel） */
  delivered: () => Notification[];
  /** Claude に返した許可の回答（notifications/claude/channel/permission の params） */
  verdicts: () => Notification['params'][];
  /** chat.postMessage の呼び出し */
  posts: () => ApiCall[];
  /** 投稿の本文（markdown_text、無ければ text） */
  postTexts: () => string[];
  stop: () => Promise<void>;
  lockReleased: number;
  order: string[];
}

/** startHarness の設定。access の既定は ACCESS。ほかは startBridgeApp にそのまま渡す */
type HarnessOptions = { access?: ParsedAccess; replyTimeoutMs?: number } & Pick<
  BridgeAppOptions,
  | 'console'
  | 'allowExtraFile'
  | 'denyFiles'
  | 'home'
  | 'hookInboxFile'
  | 'hookPollMs'
  | 'restartFlagFile'
  | 'killParent'
  | 'sessionAllowAll'
  | 'managedSettingsFiles'
  | 'sessionTag'
  | 'workDir'
  | 'keepalive'
  | 'usageWatch'
  | 'crashFile'
>;

async function startHarness({ access = ACCESS, replyTimeoutMs, ...extra }: HarnessOptions = {}): Promise<Harness> {
  const { bridge, web, socket, logger } = makeBridge({ access });
  await bridge.init();
  web.calls.length = 0;

  const { client, notifications, serverTransport, connect } = linkClient();

  const harness: Harness = {
    web,
    socket,
    logger,
    client,
    notifications,
    delivered: () => notifications.filter((x) => x.method === 'notifications/claude/channel'),
    verdicts: () =>
      notifications.filter((x) => x.method === 'notifications/claude/channel/permission').map((x) => x.params),
    posts: () => web.calls.filter((c) => c.method === 'chat.postMessage'),
    postTexts: () => harness.posts().map((c) => String(c.args.markdown_text ?? c.args.text)),
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
  await connect();
  harness.stop = app.stop;
  return harness;
}

interface HarnessSlot {
  /** 一時フォルダー（tempPrefix を渡したときだけ。テストごとに作り直す） */
  readonly dir: string;
  /** ハーネスを起動する。起動したものはテストの後に閉じる */
  start: (options?: HarnessOptions) => Promise<Harness>;
}

/**
 * describe の中で呼ぶ。テストの中で start したハーネスを、各テストの後に閉じる。
 * tempPrefix を渡すと、各テストの前に一時フォルダーを作り、ハーネスを閉じた後で消す
 */
function useHarnessSlot(tempPrefix?: string): HarnessSlot {
  let dir = '';
  let started: Harness | undefined;

  if (tempPrefix !== undefined) {
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix));
    });
  }
  afterEach(async () => {
    await started?.client.close();
    await started?.stop();
    started = undefined;
    if (tempPrefix !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    get dir() {
      return dir;
    },
    start: async (options) => {
      started = await startHarness(options);
      return started;
    },
  };
}

/**
 * describe の中で呼ぶ。各テストの前にハーネスを起動して onStarted に渡し、後で閉じる。
 * options は一時フォルダー（tempPrefix を渡したとき）のパスを受け取って、起動の設定を返す
 */
function useHarness(
  onStarted: (h: Harness) => void,
  setup: { tempPrefix?: string; options?: (dir: string) => HarnessOptions } = {}
): HarnessSlot {
  const slot = useHarnessSlot(setup.tempPrefix);
  beforeEach(async () => {
    onStarted(await slot.start(setup.options?.(slot.dir)));
  });
  return slot;
}

/** 本文の末尾の署名に付く、代理投稿したアプリのボットのユーザー ID（このブリッジの BOT とは別のアプリ） */
const OTHER_APP_BOT = 'U0BF61P77U1';

/** ツールの結果の 1 つ目の文 */
function toolText(res: Awaited<ReturnType<Client['callTool']>>): string {
  const first = (res.content as { type: string; text?: string }[])[0];
  return first?.text ?? '';
}

/** 許可ユーザーの DM の受信。同じ ts でも続けて届くよう、event_id は毎回変える */
function dmEnvelope(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return messageEnvelope({ text, ts: '10.1', ...overrides }, { eventId: `Ev-${Math.random()}` });
}

/** 許可ユーザーが DM1 のメッセージ（ts=55.5）のボタンを押した受信 */
function blockAction(actionId: string, value: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return blockActionEnvelope({ container: { message_ts: '55.5' }, actions: [{ action_id: actionId, value }], ...overrides });
}

/** Claude 側から permission_request を送り、ブリッジが処理し終えるのを待つ。省略した項目は Bash の ls */
async function requestPermission(client: Client, params: Partial<PermissionRequestParams> = {}): Promise<void> {
  await notifyPermissionRequest(client, params);
  await flush();
}

/**
 * 受信の後に続く処理まで待つ。ボタンやコマンドの処理は、受信の列の中でさらに非同期の処理
 * （ファイルの書き込み・コンソールへの送信・投稿）を待つ。flush 1 回では、その後の段が終わらないことがある
 */
async function settle(): Promise<void> {
  await flush();
  await flush();
}

/** command を実行する Bash の permission_request を送る */
async function requestBash(client: Client, command: string, requestId = 'abcde'): Promise<void> {
  await requestPermission(client, { request_id: requestId, description: 'run', input_preview: JSON.stringify({ command }) });
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
  useHarness((started) => (h = started));

  it('DM が notifications/claude/channel として届き、その後 eyes リアクションが付く', async () => {
    h.socket.emit('slack_event', dmEnvelope('hello'));
    await flush();

    const n = h.delivered()[0];
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

  /** permission_request を全 DM に配信させてから、DM1 で "yes ABCDE" と答える。配信の投稿は calls から除く */
  async function answerYes(): Promise<void> {
    await requestPermission(h.client);
    h.web.calls.length = 0;
    h.socket.emit('slack_event', dmEnvelope('yes ABCDE'));
    await flush();
  }

  it('permission_request はボタン付きで全 DM に配信される', async () => {
    await requestPermission(h.client);

    const posts = h.posts();
    expect(posts.map((p) => p.args.channel)).toEqual([DM1, DM2]);
    expect(posts[0]?.args.blocks).toBeDefined();
    expect(String(posts[0]?.args.text)).toContain('Bash');
  });

  it('"yes ID" は allow の verdict になり、通常のメッセージとしては届かない', async () => {
    await answerYes();

    expect(h.verdicts()[0]).toEqual({ request_id: 'abcde', behavior: 'allow' });
    expect(h.delivered()).toEqual([]);
  });

  it('"yes ID" の後は、全 DM の確認を書き換えてから、答えた DM に許可のリアクションを付ける', async () => {
    await answerYes();

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
    await requestPermission(h.client);
    h.web.calls.length = 0;

    h.socket.emit('slack_event', dmEnvelope('no abcde'));
    await flush();

    expect(h.verdicts()[0]).toEqual({ request_id: 'abcde', behavior: 'deny' });
    const reactions = h.web.calls.filter((c) => c.method === 'reactions.add');
    expect(reactions[0]?.args.name).toBe(REACTION.DENY);
    expect(String(h.web.calls.find((c) => c.method === 'chat.update')?.args.text)).toContain('Denied');
  });

  it('記録のない ID への "yes" は verdict にせず、通常のメッセージとして届ける', async () => {
    await requestPermission(h.client);
    h.web.calls.length = 0;

    h.socket.emit('slack_event', dmEnvelope('yes maybe'));
    await flush();

    expect(h.verdicts()).toEqual([]);
    const n = h.delivered()[0];
    expect(n?.params?.content).toBe('yes maybe');
    expect(h.web.calls).toEqual([{ method: 'reactions.add', args: { channel: DM1, timestamp: '10.1', name: REACTION.SEEN } }]);
  });

  it('permission_request は直前に受信したスレッドにだけ返信される', async () => {
    h.socket.emit('slack_event', dmEnvelope('hello', { ts: '20.1', thread_ts: '20.0' }));
    await flush();
    h.web.calls.length = 0;

    await requestPermission(h.client);
    const posts = h.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.args.channel).toBe(DM1);
    expect(posts[0]?.args.thread_ts).toBe('20.0');
  });

  it('Allow ボタンで verdict が返り、押されたメッセージが書き換わる', async () => {
    await requestPermission(h.client);
    h.web.calls.length = 0;

    h.socket.emit('interactive', blockAction('perm_allow', 'abcde', { container: { message_ts: '100.1' } }));
    await flush();

    expect(h.verdicts()[0]).toEqual({ request_id: 'abcde', behavior: 'allow' });
    const updates = h.web.calls.filter((c) => c.method === 'chat.update');
    expect(updates).toHaveLength(2);
    expect(String(updates[0]?.args.text)).toContain('Allowed');
    // ボタンではリアクションは付けない
    expect(h.web.calls.some((c) => c.method === 'reactions.add')).toBe(false);
  });

  it('期限切れ（未登録）の Deny ボタンは Claude に送らず、押されたメッセージを expired 表示にする', async () => {
    h.socket.emit('interactive', blockAction('perm_deny', 'abcde'));
    await flush();

    expect(h.verdicts()).toEqual([]);
    const updates = h.web.calls.filter((c) => c.method === 'chat.update');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.args).toMatchObject({ channel: DM1, ts: '55.5' });
    expect(String(updates[0]?.args.text)).toContain('expired');
  });

  it('See more はスレッド外のボタンなら container.message_ts を起点に、input_preview 全文をコードブロックで送る', async () => {
    const preview = 'x'.repeat(5000);
    await requestPermission(h.client, { input_preview: preview });
    h.web.calls.length = 0;

    h.socket.emit('interactive', blockAction('perm_more', 'abcde', { container: { message_ts: '100.1' } }));
    await flush();

    const posts = h.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.args.channel).toBe(DM1);
    expect(posts[0]?.args.thread_ts).toBe('100.1');
    expect(posts[0]?.args.markdown_text).toBe('```\n' + preview + '\n```');
    expect(posts[0]?.args.blocks).toBeUndefined();
    // permission 自体は保留のまま
    expect(h.verdicts()).toEqual([]);
  });

  it('See more はスレッド内のボタンならスレッドの親に送り、長い全文はコードブロックを保って分割する', async () => {
    const preview = ('y'.repeat(99) + '\n').repeat(300);
    await requestPermission(h.client, { input_preview: preview });
    h.web.calls.length = 0;

    h.socket.emit(
      'interactive',
      blockAction('perm_more', 'abcde', { container: { message_ts: '100.1', thread_ts: '20.0' } })
    );
    await flush();

    const posts = h.posts();
    expect(posts.length).toBeGreaterThan(1);
    for (const p of posts) {
      expect(p.args.thread_ts).toBe('20.0');
      const body = String(p.args.markdown_text);
      expect(body.startsWith('```\n')).toBe(true);
      expect(body.endsWith('\n```')).toBe(true);
    }
  });

  it('See more の全文でも双方向制御文字・ゼロ幅文字を \\u{XXXX} の形で見せる', async () => {
    await requestPermission(h.client, { input_preview: 'rm -rf \u202e/ \u200bok' });
    h.web.calls.length = 0;

    h.socket.emit('interactive', blockAction('perm_more', 'abcde', { container: { message_ts: '100.1' } }));
    await flush();

    const posts = h.posts();
    expect(posts[0]?.args.markdown_text).toBe('```\nrm -rf \\u{202E}/ \\u{200B}ok\n```');
  });

  it('fencePreview は中身の行頭の ``` を無効化してからコードブロックで包む', () => {
    expect(fencePreview('a\n```js\nb\n```')).toBe('```\na\n\u200b```js\nb\n\u200b```\n```');
  });

  it('期限切れの See more は定型文をスレッドに送る', async () => {
    h.socket.emit('interactive', blockAction('perm_more', 'abcde'));
    await flush();

    const posts = h.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.args.thread_ts).toBe('55.5');
    expect(posts[0]?.args.markdown_text).toBe('⌛ permission request abcde は既に期限切れ');
  });

  it('期限切れの See more もスレッド内のボタンならスレッドの親に送る', async () => {
    h.socket.emit('interactive', blockAction('perm_more', 'abcde', { container: { message_ts: '55.5', thread_ts: '20.0' } }));
    await flush();

    const posts = h.posts();
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
  useHarness((started) => (h = started));

  it('reply は DM に投稿し "sent (N message(s)) ts=<送ったメッセージの ts>" を返す（edit_message で自分の返信を直せるように）', async () => {
    const res = await h.client.callTool({ name: 'reply', arguments: { chat_id: DM1, text: 'hi', thread_ts: '10.1' } });
    expect(toolText(res)).toMatch(/^sent \(1 message\(s\)\) ts=100\.\d+$/);
    expect(res.isError).toBeFalsy();
    const posts = h.posts();
    expect(posts).toEqual([
      {
        method: 'chat.postMessage',
        args: { channel: DM1, markdown_text: 'hi', thread_ts: '10.1', unfurl_links: false, unfurl_media: false },
      },
    ]);
  });

  it('reply の生の URL は markdown_text で [URL](URL) の形にして送る（そのままだとリンクにならない）', async () => {
    await h.client.callTool({ name: 'reply', arguments: { chat_id: DM1, text: '報告：https://claude.ai/artifact/AbC123' } });
    const posts = h.posts();
    expect(posts[0]?.args.markdown_text).toBe('報告：[https://claude.ai/artifact/AbC123](https://claude.ai/artifact/AbC123)');
  });

  it('長い reply は分割され、件数が返る', async () => {
    const text = ('あ'.repeat(99) + '\n').repeat(300);
    const res = await h.client.callTool({ name: 'reply', arguments: { chat_id: DM1, text } });
    const posts = h.posts();
    expect(posts.length).toBeGreaterThan(1);
    expect(toolText(res)).toMatch(new RegExp(`^sent \\(${posts.length} message\\(s\\)\\) ts=(100\\.\\d+,){${posts.length - 1}}100\\.\\d+$`));
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

  it('react は reactions.add の失敗が already_reacted（もう付いている）なら reacted を返す', async () => {
    h.web.reactionError = platformError('already_reacted');
    const res = await h.client.callTool({ name: 'react', arguments: { chat_id: DM1, message_id: '10.1', emoji: 'eyes' } });
    expect(res.content).toEqual([{ type: 'text', text: 'reacted' }]);
  });

  it('react は already_reacted 以外の失敗（絵文字名の誤りなど）なら error を返す', async () => {
    h.web.reactionError = platformError('invalid_name');
    const res = await h.client.callTool({ name: 'react', arguments: { chat_id: DM1, message_id: '10.1', emoji: 'thumbs_up' } });
    expect(res.content).toEqual([{ type: 'text', text: 'error: An API error occurred: invalid_name' }]);
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

  /** 片付けの各段の呼び出しを記録するハーネスを起動する。stopOrder() は stop が呼んだ順を返す */
  async function startRecordingStop(): Promise<{ h: Harness; stopOrder: () => string[] }> {
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
    return { h, stopOrder: () => [...h.order, ...order] };
  }

  it('stop は lock.release → relay.denyAll → bridge.stop → server.close の順で片付ける', async () => {
    const { h, stopOrder } = await startRecordingStop();
    await h.stop();
    expect(stopOrder()).toEqual(['lock.release', 'relay.denyAll', 'bridge.stop', 'server.close']);
  });

  it('stop を 2 回呼んでも 1 回だけ片付ける', async () => {
    const { h, stopOrder } = await startRecordingStop();
    await h.stop();
    await h.stop();
    expect(stopOrder()).toEqual(['lock.release', 'relay.denyAll', 'bridge.stop', 'server.close']);
    expect(h.socket.disconnected).toBe(1);
    expect(h.lockReleased).toBe(1);
  });

  it('stop は保留中の permission request に deny を返し、Slack のメッセージを書き換えてから切断する', async () => {
    const h = await startHarness();
    await requestPermission(h.client);
    h.web.calls.length = 0;

    await h.stop();
    await flush();

    expect(h.verdicts()).toEqual([{ request_id: 'abcde', behavior: 'deny' }]);
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
    const { bridge, socket, logger } = makeBridge();
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

  it('起動の途中（ホームタブの更新中）に終了処理が始まったら、hook の読み取りを始めない', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-stop-early-'));
    const hooks = path.join(dir, 'hooks.jsonl');
    try {
      const { bridge, web, logger } = makeBridge();
      await bridge.init();
      let stop: (() => Promise<void>) | undefined;
      let stopping: Promise<void> | undefined;
      const publish = bridge.publishHome.bind(bridge);
      vi.spyOn(bridge, 'publishHome').mockImplementation(async (user, view) => {
        stopping ??= stop?.();
        await publish(user, view);
      });
      const [, serverTransport] = InMemoryTransport.createLinkedPair();
      await startBridgeApp({
        bridge,
        logger,
        transport: serverTransport,
        onCleanupReady: (s) => (stop = s),
        hookInboxFile: hooks,
        hookPollMs: 10,
        home: { users: ACCESS.allowFrom, channelCount: 0 },
      });
      await stopping;
      web.calls.length = 0;

      fs.writeFileSync(hooks, JSON.stringify({ at: Date.now(), hook_event_name: 'SessionEnd', reason: 'other' }) + '\n');
      await new Promise((r) => setTimeout(r, 60));
      expect(web.calls.filter((c) => c.method === 'chat.postMessage')).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
  /** 縮退モードでツールが返す error 文 */
  const BUSY_REPLY = 'error: 別のインスタンスが動いているため、この Slack ブリッジは送信できない';

  /** 縮退モード（ロックの取り直し無し）で起動し、MCP の client をつなぐ */
  async function startDegradedClient() {
    const logger = new Logger({ stderr: false });
    const warnSpy = vi.spyOn(logger, 'warn');
    const { client, serverTransport, connect } = linkClient();
    const app = await startDegradedApp({ logger, transport: serverTransport });
    await connect();
    return { app, client, warnSpy };
  }

  it.each([
    ['reply', { chat_id: DM1, text: 'hi' }],
    ['react', { chat_id: DM1, message_id: '1', emoji: 'eyes' }],
    ['edit_message', { chat_id: DM1, message_id: '1', text: 'x' }],
  ])('ツール %s は error 文を返す', async (name, args) => {
    const { app, client } = await startDegradedClient();
    const res = await client.callTool({ name, arguments: args });
    expect(res.content).toEqual([{ type: 'text', text: BUSY_REPLY }]);

    await client.close();
    await app.stop();
  });

  it('permission_request は warn で無視する', async () => {
    const { app, client, warnSpy } = await startDegradedClient();
    await requestPermission(client);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('縮退モード');

    await client.close();
    await app.stop();
  });

  describe('ロックの取り直し（relock）', () => {
    /** tryAcquire が results の順に答える偽のロック（尽きたら最後の値）。calls.free を true にすると、それ以降は取れる */
    function fakeLock(results: boolean[]) {
      const calls = { acquire: 0, release: 0, free: false };
      const lock = {
        tryAcquire: () => {
          const acquired = calls.free || (results[Math.min(calls.acquire, results.length - 1)] ?? false);
          calls.acquire += 1;
          return acquired ? ({ acquired: true } as const) : ({ acquired: false, holder: { pid: 1, heartbeat: 0, startedAt: 0 } } as const);
        },
        release: () => void (calls.release += 1),
      };
      return { lock, calls };
    }

    async function startDegraded(results: boolean[], failStarts: ('auth' | 'closed')[] = []) {
      const logger = new Logger({ stderr: false });
      const web = makeWeb();
      const socket = makeSocket();
      socket.failStart = failStarts;
      const { lock, calls } = fakeLock(results);
      const { client, notifications, serverTransport, connect } = linkClient();
      let promoted = 0;
      const app = await startDegradedApp({
        logger,
        transport: serverTransport,
        relock: {
          lock,
          intervalMs: 10,
          promote: async (server) => {
            const { bridge } = makeBridge({ logger, web, socket });
            await bridge.init();
            const running = await startBridgeApp({ bridge, logger, server, lock });
            promoted += 1;
            return running;
          },
        },
      });
      await connect();
      return { app, client, web, socket, calls, notifications, promoted: () => promoted };
    }

    /** cond が true になるまで 5ms 間隔で待つ。約 1 秒で打ち切る */
    async function waitFor(cond: () => boolean): Promise<void> {
      await vi.waitFor(() => expect(cond()).toBe(true), { timeout: 1000, interval: 5 });
    }

    it('取れるまでは縮退のまま。取れたら同じ MCP の接続のまま通常のブリッジに戻り、Slack には投稿しない', async () => {
      const d = await startDegraded([false]);
      await waitFor(() => d.calls.acquire >= 2);
      const before = await d.client.callTool({ name: 'reply', arguments: { chat_id: DM1, text: 'hi' } });
      expect(toolText(before)).toBe(BUSY_REPLY);

      d.calls.free = true;
      await waitFor(() => d.promoted() === 1);
      const acquired = d.calls.acquire;
      expect(d.notifications.map((n) => n.method)).toContain('notifications/tools/list_changed');
      expect(d.web.calls.filter((c) => c.method === 'chat.postMessage')).toEqual([]);

      const after = await d.client.callTool({ name: 'reply', arguments: { chat_id: DM1, text: 'hi' } });
      expect(toolText(after)).toMatch(/^sent /);

      // 戻った後は取り直さない。stop で通常のブリッジごと止まる
      await new Promise((r) => setTimeout(r, 30));
      expect(d.calls.acquire).toBe(acquired);
      await d.app.stop();
      expect(d.socket.disconnected).toBe(1);
      expect(d.calls.release).toBe(1);
      await d.client.close();
    });

    it('戻るのに失敗したら、ロックを手放して縮退モードに戻り、次の間隔で取り直す', async () => {
      const d = await startDegraded([true], ['auth']);
      await waitFor(() => d.calls.acquire >= 2 && d.promoted() === 1);
      // 1 回目の失敗の後片付けで、startBridgeApp の stop と縮退モードの両方が release する（2 回目は持ち主でないので何もしない）
      expect(d.calls.release).toBe(2);
      const reply = await d.client.callTool({ name: 'reply', arguments: { chat_id: DM1, text: 'hi' } });
      expect(toolText(reply)).toMatch(/^sent /);
      await d.app.stop();
      await d.client.close();
    });

    it('失敗して縮退モードに戻った間は、ツールが error 文を返す', async () => {
      const d = await startDegraded([true, false], ['auth']);
      await waitFor(() => d.calls.acquire >= 2);
      const reply = await d.client.callTool({ name: 'reply', arguments: { chat_id: DM1, text: 'hi' } });
      expect(toolText(reply)).toBe(BUSY_REPLY);
      expect(d.promoted()).toBe(0);
      await d.app.stop();
      await d.client.close();
    });

    it('戻る途中に stop したら、戻り終わるのを待ってから通常のブリッジを止める', async () => {
      const logger = new Logger({ stderr: false });
      const { lock } = fakeLock([true]);
      const { client, serverTransport, connect } = linkClient();
      let entered = false;
      let finish: () => void = () => undefined;
      const promotedStop = vi.fn(async () => undefined);
      const app = await startDegradedApp({
        logger,
        transport: serverTransport,
        relock: {
          lock,
          intervalMs: 10,
          promote: async () => {
            entered = true;
            await new Promise<void>((r) => (finish = r));
            return { stop: promotedStop };
          },
        },
      });
      await connect();
      await waitFor(() => entered);

      let stopped = false;
      const stopping = app.stop().then(() => (stopped = true));
      await new Promise((r) => setTimeout(r, 20));
      expect(stopped).toBe(false);
      finish();
      await stopping;
      expect(promotedStop).toHaveBeenCalledTimes(1);
      await client.close();
    });

    it('stop の後は取り直さない', async () => {
      const d = await startDegraded([false]);
      await d.app.stop();
      const count = d.calls.acquire;
      await new Promise((r) => setTimeout(r, 40));
      expect(d.calls.acquire).toBe(count);
      await d.client.close();
    });
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
  /** postText は Error を、updateText は Error でない値を投げ、addReactionOrThrow は成功する bridge で作る */
  function handlersWithFailingBridge() {
    const logger = new Logger({ stderr: false });
    const errorSpy = vi.spyOn(logger, 'error');
    const handlers = createToolHandlers(
      {
        postText: async () => {
          throw new Error('boom');
        },
        addReactionOrThrow: async () => undefined,
        updateText: async () => {
          throw 'not-an-error';
        },
      },
      logger
    );
    return { handlers, errorSpy };
  }

  it('bridge が Error を投げたら、message を error 文にして返し、logger.error に残す', async () => {
    const { handlers, errorSpy } = handlersWithFailingBridge();
    expect(await handlers.onReply({ chat_id: DM1, text: 'x' })).toBe('error: boom');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('bridge が Error でない値を投げても、文字列にして error 文で返し、logger.error に残す', async () => {
    const { handlers, errorSpy } = handlersWithFailingBridge();
    expect(await handlers.onEdit({ chat_id: DM1, message_id: '1', text: 'x' })).toBe('error: not-an-error');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('bridge が成功すれば結果を返し、logger.error には残さない', async () => {
    const { handlers, errorSpy } = handlersWithFailingBridge();
    expect(await handlers.onReact({ chat_id: DM1, message_id: '1', emoji: ':+1:' })).toBe('reacted');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('onActivity（無応答の見張りを解く）は返事にあたる reply / react / edit_message だけで呼び、download_file では呼ばない', async () => {
    const onActivity = vi.fn();
    const handlers = createToolHandlers(
      {
        postText: async () => ({ ts: ['1.0'] }),
        addReactionOrThrow: async () => undefined,
        updateText: async () => undefined,
      },
      new Logger({ stderr: false }),
      onActivity,
      {
        info: async () => {
          throw new Error('not found');
        },
        fetch: async () => {
          throw new Error('not found');
        },
        dir: os.tmpdir(),
      }
    );
    await handlers.onDownload?.({ file_id: 'F1' });
    expect(onActivity).not.toHaveBeenCalled();

    await handlers.onReply({ chat_id: DM1, text: 'x' });
    await handlers.onReact({ chat_id: DM1, message_id: '1', emoji: 'eyes' });
    await handlers.onEdit({ chat_id: DM1, message_id: '1', text: 'x' });
    expect(onActivity).toHaveBeenCalledTimes(3);
  });
});

describe('チャンネル（access.channels）', () => {
  const CH = 'C333CCC';
  let h: Harness;
  useHarness((started) => (h = started), { options: () => ({ access: { ...ACCESS, channels: [CH] } }) });

  /** チャンネルの投稿。既定ではボットへのメンションを付ける（mention: false で付けない） */
  function channelEnvelope(
    text: string,
    overrides: Record<string, unknown> = {},
    mention = true
  ): Record<string, unknown> {
    return dmEnvelope(mention ? `<@${BOT}> ${text}` : text, { channel_type: 'channel', channel: CH, ...overrides });
  }

  const deliveredContents = () => h.delivered().map((x) => x.params?.content);

  it('メンションの無い投稿には反応しない（リアクションも付けない）', async () => {
    h.socket.emit('slack_event', channelEnvelope('just chatting', { ts: '31.1' }, false));
    await flush();
    expect(deliveredContents()).toEqual([]);
    expect(h.web.calls).toEqual([]);
  });

  it('メンションで話しかけたスレッドの続きは、メンション無しでも届く。関係ないスレッドは届かない', async () => {
    h.socket.emit('slack_event', channelEnvelope('start', { ts: '32.0' }));
    h.socket.emit('slack_event', channelEnvelope('follow up', { ts: '32.1', thread_ts: '32.0' }, false));
    h.socket.emit('slack_event', channelEnvelope('other thread', { ts: '33.1', thread_ts: '33.0' }, false));
    await flush();
    expect(deliveredContents()).toEqual(['start', 'follow up']);
  });

  it('ボットが投稿したスレッドへの返信は、メンション無しでも届く', async () => {
    const res = await h.client.callTool({ name: 'reply', arguments: { chat_id: CH, text: 'お知らせ' } });
    expect(res.isError).toBeFalsy();
    // 偽の Slack は投稿ごとに 100.1, 100.2, ... と ts を振る。この describe では最初の投稿
    expect(h.posts()).toHaveLength(1);

    h.socket.emit('slack_event', channelEnvelope('返信', { ts: '34.1', thread_ts: '100.1' }, false));
    await flush();
    expect(deliveredContents()).toEqual(['返信']);
  });

  it('許可チャンネルの投稿が Claude に届き、同じチャンネルに返信・リアクションできる', async () => {
    h.socket.emit('slack_event', channelEnvelope('hello', { ts: '30.1' }));
    await flush();

    const n = h.delivered()[0];
    expect(n?.params?.meta).toMatchObject({ chat_id: CH, thread_ts: '30.1' });
    expect(h.web.calls).toEqual([{ method: 'reactions.add', args: { channel: CH, timestamp: '30.1', name: REACTION.SEEN } }]);

    const res = await h.client.callTool({ name: 'reply', arguments: { chat_id: CH, text: 'hi', thread_ts: '30.1' } });
    expect(toolText(res)).toMatch(/^sent \(1 message\(s\)\) ts=/);
  });

  it('非公開チャンネル（group）も受け付け、許可外のチャンネルと許可外ユーザーは無視する', async () => {
    h.socket.emit('slack_event', channelEnvelope('private', { channel_type: 'group' }));
    h.socket.emit('slack_event', channelEnvelope('other', { channel: 'C999ZZZ' }));
    h.socket.emit('slack_event', channelEnvelope('stranger', { user: 'U999ZZZ' }));
    await flush();

    expect(deliveredContents()).toEqual(['private']);
  });

  it('permission_request はチャンネルのスレッドに返信され、そのボタンで回答できる', async () => {
    h.socket.emit('slack_event', channelEnvelope('do it', { ts: '30.2', thread_ts: '30.0' }));
    await flush();
    h.web.calls.length = 0;

    await requestPermission(h.client);
    const posts = h.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.args).toMatchObject({ channel: CH, thread_ts: '30.0' });
    h.web.calls.length = 0;

    h.socket.emit(
      'interactive',
      blockAction('perm_allow', 'abcde', { channel: { id: CH }, container: { message_ts: '100.1' } })
    );
    await flush();

    expect(h.verdicts()[0]).toEqual({ request_id: 'abcde', behavior: 'allow' });
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
    await requestPermission(h.client);
    const posts = h.posts();
    expect(posts.map((p) => p.args.channel)).toEqual([CH, DM1, DM2]);
  });
});

describe('無応答の見張り（replyTimeoutMs）', () => {
  let h: Harness;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const warnings = () => h.posts().filter((c) => String(c.args.text).includes('応答が無い'));
  useHarness((started) => (h = started), { options: () => ({ replyTimeoutMs: 60 }) });

  it('Claude が何も返さないまま待ち時間を過ぎたら、そのスレッドに警告を投稿する', async () => {
    h.socket.emit('slack_event', dmEnvelope('hello', { ts: '40.1', thread_ts: '40.0' }));
    await flush();
    await vi.waitFor(() => expect(warnings()).toHaveLength(1));
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
    await requestPermission(h.client);
    await wait(120);

    expect(warnings()).toHaveLength(0);
  });
});

describe('parseCommand', () => {
  it.each([
    ['!status', 'status'],
    ['  !RESTART   FORCE ', 'restart force'],
    ['!clear', 'clear'],
    ['!Help', 'help'],
    ['!keepalive', 'keepalive'],
    ['!keepalive  OFF', 'keepalive off'],
  ])('コマンドだけの本文 %j を正規化して %j を返す', (text, expected) => {
    expect(parseCommand(text)).toBe(expected);
  });

  it('!keepalive の後ろが知らない語ならコマンドにしない', () => {
    expect(parseCommand('!keepalive maybe')).toBeUndefined();
  });

  it('アプリの署名（太字 + メンション）が末尾にあっても認める', () => {
    expect(parseCommand(`!status *使用して送信されました* <@${OTHER_APP_BOT}>`)).toBe('status');
    expect(parseCommand(`!compact\n*Sent using* <@${OTHER_APP_BOT}|Claude>`)).toBe('compact');
  });

  it('コマンドの後ろに普通の文があればコマンドにしない', () => {
    expect(parseCommand('!restart してから続けて')).toBeUndefined();
    expect(parseCommand('!restart\nそのあと *これ* を見て')).toBeUndefined();
    expect(parseCommand(`!status <@${OTHER_APP_BOT}>`)).toBeUndefined();
    expect(parseCommand(`status *a* <@${OTHER_APP_BOT}>`)).toBeUndefined();
  });
});

describe('起動時の、今の方式では作れない保存済みのルールの知らせ（D-SD-03）', () => {
  const harness = useHarnessSlot('app-rejected-');
  let file: string;

  beforeEach(() => {
    file = path.join(harness.dir, 'allow-extra.json');
  });

  it('前の方式で足したルールがあれば、件数と一覧を知らせる。allow-extra.json は書き換えない', async () => {
    const saved = JSON.stringify({ allow: ['Bash(git status)', 'Bash(git log:*)', 'WebFetch'] });
    fs.writeFileSync(file, saved);
    const h = await harness.start({ allowExtraFile: file });
    await flush();

    const notice = h.postTexts().find((t) => t.includes('作れないルール'));
    expect(notice).toContain('2 件');
    expect(notice).toContain('• Bash(git log:*)');
    expect(notice).toContain('• WebFetch');
    expect(notice).not.toContain('Bash(git status)');
    expect(fs.readFileSync(file, 'utf8')).toBe(saved);
  });

  it('作れないルールが無ければ知らせない', async () => {
    fs.writeFileSync(file, JSON.stringify({ allow: ['Bash(git status)'] }));
    const h = await harness.start({ allowExtraFile: file });
    await flush();
    expect(h.postTexts().some((t) => t.includes('作れないルール'))).toBe(false);
  });
});

describe('ターミナル画面と許可リスト（!screen / 今後も許可 / !rules）', () => {
  let h: Harness;
  let sent: ConsoleKey[][];
  const harness = useHarness((started) => (h = started), {
    tempPrefix: 'app-rules-',
    options: (dir) => {
      const denyFile = path.join(dir, 'settings.json');
      fs.writeFileSync(denyFile, JSON.stringify({ permissions: { deny: ['Bash(pwd -P:*)'] } }));
      sent = [];
      return {
        console: { read: async () => CHROME_CHOICE_SCREEN, sendKeys: async (keys) => void sent.push(keys), sendCommand: async () => undefined },
        allowExtraFile: path.join(dir, 'allow-extra.json'),
        denyFiles: [denyFile],
      };
    },
  });

  it('!screen は Claude に渡さず、選択肢のボタンを出し、押すと選択キーを送る', async () => {
    h.socket.emit('slack_event', dmEnvelope('!screen', { ts: '50.1' }));
    await flush();

    expect(h.delivered()).toEqual([]);
    const pick = actionsOf(h.posts()[0]?.args.blocks as unknown[])[2];
    expect(pick?.action_id).toBe('screen_pick_2');

    h.socket.emit(
      'interactive',
      blockAction(pick?.action_id ?? '', pick?.value ?? '', { container: { message_ts: '100.1', thread_ts: '50.1' } })
    );
    await settle();
    expect(sent).toEqual([['Down', 'Enter']]);
  });

  it('今後も許可: 今回は許可し、確認のうえ allow-extra.json に書き込む', async () => {
    await requestBash(h.client, 'git status');
    h.web.calls.length = 0;

    h.socket.emit('interactive', blockAction('perm_always', 'abcde', { container: { message_ts: '100.1' } }));
    await settle();

    expect(h.verdicts()[0]).toEqual({ request_id: 'abcde', behavior: 'allow' });
    const proposal = h.posts().find((p) => String(p.args.text).includes('Bash(git status)'));
    const add = actionsOf(proposal?.args.blocks as unknown[]).find((e) => e.action_id === 'rule_add');

    h.socket.emit('interactive', blockAction('rule_add', add?.value ?? '', { container: { message_ts: '100.2' } }));
    await settle();
    expect(JSON.parse(fs.readFileSync(path.join(harness.dir, 'allow-extra.json'), 'utf8'))).toEqual({ allow: ['Bash(git status)'] });
  });

  it('今後も許可: deny に当たるなら、今回は許可したうえで追加しない旨と当たった deny を知らせる', async () => {
    // 候補は Bash(pwd)。deny の Bash(pwd -P:*) と範囲が重なる
    await requestBash(h.client, 'pwd');
    h.web.calls.length = 0;

    h.socket.emit('interactive', blockAction('perm_always', 'abcde', { container: { message_ts: '100.1' } }));
    await settle();

    expect(h.verdicts()[0]).toEqual({ request_id: 'abcde', behavior: 'allow' });
    const notice = h.posts().find((p) => String(p.args.markdown_text).includes('deny に当たる'));
    expect(String(notice?.args.markdown_text)).toContain('Bash(pwd -P:*)');
    expect(fs.existsSync(path.join(harness.dir, 'allow-extra.json'))).toBe(false);
  });

  it('!rules で追加分を一覧できる', async () => {
    fs.writeFileSync(path.join(harness.dir, 'allow-extra.json'), JSON.stringify({ allow: ['WebFetch'] }));
    h.socket.emit('slack_event', dmEnvelope('!rules', { ts: '60.1' }));
    await flush();
    expect(String(h.posts()[0]?.args.text)).toContain('1 件');
  });
});

describe('ホームタブ', () => {
  let h: Harness;
  const home = { users: ACCESS.allowFrom, channelCount: 0 };
  const publishes = () => h.web.calls.filter((c) => c.method === 'views.publish');

  function homeOpened(user: string, tab = 'home', teamId = 'T123ABC'): Record<string, unknown> {
    return eventEnvelope({ type: 'app_home_opened', user, tab }, { eventId: `Ev-${Math.random()}`, teamId });
  }

  // startHarness は起動前に web.calls を空にするので、起動時の publish は残る
  useHarness((started) => (h = started), { options: () => ({ home, workDir: 'C:\\dev' }) });

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

describe('!status / !restart / !compact / !clear / !help', () => {
  const PROMPT = ['Claude: done.', '', '❯ ', '  ? for shortcuts'].join('\n');
  let h: Harness;
  let flag: string;
  let screen: string;
  let commands: string[];
  let killed: number;
  useHarness(
    (started) => {
      h = started;
      h.web.calls.length = 0;
    },
    {
      tempPrefix: 'app-session-',
      options: (dir) => {
        flag = path.join(dir, 'restart.flag');
        screen = PROMPT;
        commands = [];
        killed = 0;
        return {
          console: { read: async () => screen, sendKeys: async () => undefined, sendCommand: async (c) => void commands.push(c) },
          restartFlagFile: flag,
          killParent: () => void killed++,
          // home は渡さない（ホームタブ無しでも !status に作業フォルダーが出る）
          workDir: 'C:\\dev\\app',
        };
      },
    }
  );

  it('!status は Claude に渡さず、稼働状態をスレッドに返す', async () => {
    h.socket.emit('slack_event', dmEnvelope('!status', { ts: '80.1' }));
    await flush();

    expect(h.delivered()).toEqual([]);
    expect(h.posts()[0]?.args).toMatchObject({ channel: DM1, thread_ts: '80.1' });
    const text = h.postTexts()[0] ?? '';
    expect(text).toContain('ブリッジの状態');
    expect(text).toContain('C:\\dev\\app');
    expect(text).toContain('返事待ち: 無し');
    expect(text).toContain('実行許可: 0 件');
  });

  it('アプリが代理投稿した !status（末尾に署名付き）もコマンドとして扱う', async () => {
    h.socket.emit('slack_event', dmEnvelope(`!status *使用して送信されました* <@${OTHER_APP_BOT}>`, { ts: '80.2' }));
    await flush();

    expect(h.delivered()).toEqual([]);
    expect(h.postTexts()[0] ?? '').toContain('ブリッジの状態');
  });

  it('!restart は restart.flag を置いて /exit を送る', async () => {
    h.socket.emit('slack_event', dmEnvelope('!restart', { ts: '81.1' }));
    await settle();

    expect(fs.existsSync(flag)).toBe(true);
    expect(commands).toEqual(['exit']);
    expect(killed).toBe(0);
    expect(h.postTexts().join('\n')).toContain('/exit を送った');
  });

  it('入力待ちでなければ /exit を送らず、置いた印を消す（残すと、後で手元で終了したときに起動し直す）', async () => {
    screen = 'Thinking…\n⠋ Working';
    h.socket.emit('slack_event', dmEnvelope('!restart', { ts: '82.1' }));
    await settle();

    expect(commands).toEqual([]);
    expect(h.postTexts().join('\n')).toContain('入力待ちでない');
    expect(fs.existsSync(flag)).toBe(false);
  });

  it('!restart force は印を置いて claude.exe を止める', async () => {
    h.socket.emit('slack_event', dmEnvelope('!restart  force', { ts: '83.1' }));
    await settle();

    expect(fs.existsSync(flag)).toBe(true);
    expect(killed).toBe(1);
    expect(commands).toEqual([]);
  });

  it('!compact は /compact を送り、印は置かない', async () => {
    h.socket.emit('slack_event', dmEnvelope('!compact', { ts: '84.1' }));
    await settle();

    expect(commands).toEqual(['compact']);
    expect(fs.existsSync(flag)).toBe(false);
  });

  it('!clear は /clear を送り、印は置かない', async () => {
    h.socket.emit('slack_event', dmEnvelope('!clear', { ts: '85.1' }));
    await settle();

    expect(h.delivered()).toEqual([]);
    expect(commands).toEqual(['clear']);
    expect(fs.existsSync(flag)).toBe(false);
    expect(h.postTexts().join('\n')).toContain('/clear を送った');
  });

  it('入力待ちでなければ /clear を送らない', async () => {
    screen = 'Thinking…\n⠋ Working';
    h.socket.emit('slack_event', dmEnvelope('!clear', { ts: '85.2' }));
    await settle();

    expect(commands).toEqual([]);
    expect(h.postTexts().join('\n')).toContain('入力待ちでない');
  });

  it('!help は Claude に渡さず、コマンドの一覧をスレッドに返す', async () => {
    h.socket.emit('slack_event', dmEnvelope('!help', { ts: '86.1' }));
    await flush();

    expect(h.delivered()).toEqual([]);
    expect(h.posts()[0]?.args).toMatchObject({ channel: DM1, thread_ts: '86.1' });
    const text = h.postTexts()[0] ?? '';
    for (const c of ['!help', '!status', '!screen', '!rules', '!compact', '!clear', '!restart', '!restart force']) {
      expect(text).toContain(`\`${c}\``);
    }
  });
});

/**
 * ここまでに hooks.jsonl に書いた行を、ブリッジが読み終えるまで待つ。必ず知らせる行（目印）を書き足し、その投稿が届くのを待つ。
 * 行は書いた順に処理されるので、目印が届いた時点でそれより前の行は処理済み。目印の投稿は calls から取り除く
 */
async function drainHooks(h: Harness, file: string, fields: Record<string, unknown> = {}): Promise<void> {
  const marker = `drain-${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(file, JSON.stringify({ at: Date.now(), hook_event_name: 'StopFailure', error_details: marker, ...fields }) + '\n');
  const isMarker = (c: { method: string; args: Record<string, unknown> }) =>
    c.method === 'chat.postMessage' && String(c.args.text).includes(marker);
  await vi.waitFor(() => expect(h.web.calls.some(isMarker)).toBe(true));
  for (let i = h.web.calls.length - 1; i >= 0; i--) {
    const call = h.web.calls[i];
    if (call && isMarker(call)) h.web.calls.splice(i, 1);
  }
}

describe('hook の記録（hooks.jsonl）からの知らせ', () => {
  let h: Harness;
  let file: string;
  const hookLine = (fields: Record<string, unknown>) => JSON.stringify({ at: Date.now(), session_id: 's1', ...fields }) + '\n';
  useHarness((started) => (h = started), {
    tempPrefix: 'app-hooks-',
    options: (dir) => {
      file = path.join(dir, 'hooks.jsonl');
      return {
        hookInboxFile: file,
        hookPollMs: 20,
        console: { read: async () => '', sendKeys: async () => undefined, sendCommand: async () => undefined },
      };
    },
  });

  it('ターミナル側の許可待ちは、画面を確認するボタン付きで許可ユーザー全員の DM に出す', async () => {
    fs.appendFileSync(file, hookLine({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs permission' }));
    await vi.waitFor(() => expect(h.posts().map((p) => p.args.channel)).toEqual([DM1, DM2]));
    expect(String(h.posts()[0]?.args.text)).toContain('ターミナル側で入力待ち');
    const blocks = h.posts()[0]?.args.blocks as { type: string; elements?: { action_id: string }[] }[];
    expect(blocks.at(-1)?.elements?.[0]?.action_id).toBe('screen_show');
  });

  it('話しかけられた後は、そのスレッドに出す', async () => {
    h.socket.emit('slack_event', dmEnvelope('hello', { ts: '70.1' }));
    await flush();
    h.web.calls.length = 0;
    fs.appendFileSync(file, hookLine({ hook_event_name: 'StopFailure', error: 'rate_limit' }));
    await vi.waitFor(() => expect(h.posts()).toHaveLength(1));
    expect(h.posts()[0]?.args).toMatchObject({ channel: DM1, thread_ts: '70.1' });
    expect(String(h.posts()[0]?.args.text)).toContain('使用量の上限');
  });

  it('Slack に中継中の許可があるときは、ターミナル側の許可待ちを重ねて知らせない', async () => {
    await requestPermission(h.client);
    h.web.calls.length = 0;
    fs.appendFileSync(file, hookLine({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }));
    await drainHooks(h, file);
    expect(h.posts()).toEqual([]);
  });

  it('Stop は Slack への返事が無いときだけ知らせる', async () => {
    fs.appendFileSync(file, hookLine({ hook_event_name: 'Stop' }));
    await drainHooks(h, file);
    expect(h.posts()).toEqual([]);

    h.socket.emit('slack_event', dmEnvelope('hello', { ts: '71.1' }));
    await flush();
    h.web.calls.length = 0;
    fs.appendFileSync(file, hookLine({ hook_event_name: 'Stop' }));
    await vi.waitFor(() => expect(h.posts()).toHaveLength(1));
    expect(String(h.posts()[0]?.args.text)).toContain('返事をしないまま');
  });
});

describe('自分のセッションの hook だけ扱う（session_tag）と、!restart で同じ会話を開き直す（session_id）', () => {
  let h: Harness;
  let file: string;
  let flag: string;
  const hookLine = (fields: Record<string, unknown>) => JSON.stringify({ at: Date.now(), ...fields }) + '\n';
  const MINE = 'c2097ecd-29b0-4cee-9f3e-a9aeace64bc3';
  const OTHER = '0d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6';
  useHarness(
    (started) => {
      h = started;
      h.web.calls.length = 0;
    },
    {
      tempPrefix: 'app-tag-',
      options: (dir) => {
        file = path.join(dir, 'hooks.jsonl');
        flag = path.join(dir, 'restart.flag');
        return {
          hookInboxFile: file,
          hookPollMs: 20,
          sessionTag: 'tag-mine',
          restartFlagFile: flag,
          console: { read: async () => '❯ ', sendKeys: async () => undefined, sendCommand: async () => undefined },
        };
      },
    }
  );

  it('タグが違う・無い行は知らせない。同じタグの行だけ知らせる', async () => {
    fs.appendFileSync(
      file,
      hookLine({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit', session_id: OTHER, session_tag: 'tag-other' }) +
        hookLine({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit', session_id: OTHER })
    );
    // 目印も自分のタグで書く（タグが違えば目印も届かない）
    await drainHooks(h, file, { session_tag: 'tag-mine' });
    expect(h.posts()).toEqual([]);

    fs.appendFileSync(file, hookLine({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit', session_id: MINE, session_tag: 'tag-mine' }));
    await vi.waitFor(() => expect(h.posts().length).toBeGreaterThan(0));
  });

  it('!restart の印に、自分のタグの行で最後に見た session_id を書く（別のタグの id は使わない）', async () => {
    fs.appendFileSync(
      file,
      hookLine({ hook_event_name: 'SessionStart', source: 'startup', session_id: MINE, session_tag: 'tag-mine' }) +
        hookLine({ hook_event_name: 'SessionStart', source: 'startup', session_id: OTHER, session_tag: 'tag-other' })
    );
    // 目印は session_id 無しで書く（覚えている id を上書きしない）
    await drainHooks(h, file, { session_tag: 'tag-mine' });

    h.socket.emit('slack_event', dmEnvelope('!restart', { ts: '90.1' }));
    await settle();
    const written = JSON.parse(fs.readFileSync(flag, 'utf8')) as { sessionId?: string };
    expect(written.sessionId).toBe(MINE);
  });

  it('session_id がまだ分からなければ、印に id を書かない（start.ps1 は新しい会話で起動する）', async () => {
    h.socket.emit('slack_event', dmEnvelope('!restart', { ts: '91.1' }));
    await settle();
    const written = JSON.parse(fs.readFileSync(flag, 'utf8')) as Record<string, unknown>;
    expect(written).not.toHaveProperty('sessionId');
  });
});

describe('このセッション中は全部許可', () => {
  const harness = useHarnessSlot('app-allowall-');
  let h: Harness;
  let hooks: string;
  const actionIds = (call: ApiCall | undefined) =>
    ((call?.args.blocks ?? []) as { type: string; elements?: { action_id: string }[] }[])
      .find((b) => b.type === 'actions')
      ?.elements?.map((e) => e.action_id) ?? [];

  /** managed: managed settings のファイルの中身（省略時はファイルを置かない） */
  async function start(sessionAllowAll: boolean, managed?: string): Promise<void> {
    const dir = harness.dir;
    const settings = path.join(dir, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ permissions: { ask: ['Bash(git push:*)'], deny: ['Bash(rm:*)', 'Read(.env)', 'Read(~/.ssh/**)'] } }));
    const managedFile = path.join(dir, 'managed-settings.json');
    if (managed !== undefined) fs.writeFileSync(managedFile, managed);
    hooks = path.join(dir, 'hooks.jsonl');
    h = await harness.start({
      denyFiles: [settings],
      managedSettingsFiles: () => [managedFile],
      sessionAllowAll,
      hookInboxFile: hooks,
      hookPollMs: 20,
    });
    // 自動許可の記録を出すスレッドを覚えさせる
    h.socket.emit('slack_event', dmEnvelope('作業して', { ts: '20.0' }));
    await flush();
    h.web.calls.length = 0;
  }

  async function enableByButton(): Promise<void> {
    await requestBash(h.client, 'git status');
    expect(actionIds(h.posts()[0])).toContain('perm_session');
    h.socket.emit('interactive', blockAction('perm_session', 'abcde', { container: { message_ts: '100.1', thread_ts: '20.0' } }));
    await settle();
    h.web.calls.length = 0;
  }

  it('無効なボットにはボタンを出さない', async () => {
    await start(false);
    await requestBash(h.client, 'git status');
    expect(actionIds(h.posts()[0])).not.toContain('perm_session');
  });

  it('ボタンで有効にすると、今回を許可し、以後は ask / deny 以外をボタン無しで許可してスレッドに記録する', async () => {
    await start(true);
    await enableByButton();
    expect(h.verdicts()).toEqual([{ request_id: 'abcde', behavior: 'allow' }]);

    await requestBash(h.client, 'npm test', 'fghij');
    expect(h.verdicts().at(-1)).toEqual({ request_id: 'fghij', behavior: 'allow' });
    expect(h.posts()).toHaveLength(1);
    expect(String(h.posts()[0]?.args.text)).toContain('自動許可: Bash');
    expect(h.posts()[0]?.args.thread_ts).toBe('20.0');
    expect(actionIds(h.posts()[0])).toEqual([]);
  });

  it('自動許可の記録は、実行許可のメッセージと同じく不可視文字を \\u{XXXX} で見せ、サロゲートペアの途中で切らない', async () => {
    await start(true);
    await enableByButton();

    await requestBash(h.client, `echo a\u202Eb${'😀'.repeat(400)}`, 'fghij');
    const record = JSON.stringify(h.posts()[0]?.args.blocks);
    expect(record).toContain('a\\\\u{202E}b');
    expect(record).not.toContain('\u202E');
    // JSON.stringify は対になっていないサロゲートだけを \ud83d の形で書く
    expect(record).not.toContain('\\ud83d');
  });

  it('deny は照合しない（Claude Code が確認の前に止めるため）。範囲付きの Read の deny があっても、別の場所の Read は自動許可する', async () => {
    await start(true);
    await enableByButton();

    await requestPermission(h.client, {
      request_id: 'fghij',
      tool_name: 'Read',
      description: 'read',
      input_preview: JSON.stringify({ file_path: 'C:\\dev\\other\\a.ts' }),
    });
    expect(h.verdicts().at(-1)).toEqual({ request_id: 'fghij', behavior: 'allow' });
    expect(String(h.posts()[0]?.args.text)).toContain('自動許可: Read');
  });

  it('有効でも、settings の ask に当たるものはボタンで聞く（全部許可のボタンはもう出さない）', async () => {
    await start(true);
    await enableByButton();

    await requestBash(h.client, 'git push origin main', 'fghij');
    expect(h.verdicts()).toHaveLength(1);
    // git push は許可リストに足せないので、♾ も出さない
    expect(actionIds(h.posts()[0])).toEqual(['perm_allow', 'perm_deny']);
  });

  it('managed settings の ask に当たるものも、ボタンで聞く', async () => {
    await start(true, JSON.stringify({ permissions: { ask: ['Bash(npm publish:*)'] } }));
    await enableByButton();

    await requestBash(h.client, 'cd pkg && npm publish', 'fghij');
    expect(h.verdicts()).toHaveLength(1);
    expect(actionIds(h.posts()[0])).toContain('perm_allow');
  });

  it('managed settings が読めない（JSON でない）ときは、全部許可のボタンを出さない', async () => {
    await start(true, '{ broken');
    await requestBash(h.client, 'git status');
    expect(actionIds(h.posts()[0])).not.toContain('perm_session');
  });

  it('!lock で解除すると、またボタンで聞く', async () => {
    await start(true);
    await enableByButton();

    h.socket.emit('slack_event', dmEnvelope('!lock', { ts: '30.0' }));
    await flush();
    expect(h.postTexts().at(-1)).toContain('解除した');

    h.web.calls.length = 0;
    await requestBash(h.client, 'npm test', 'fghij');
    expect(h.verdicts()).toHaveLength(1);
    expect(actionIds(h.posts()[0])).toContain('perm_session');
  });

  it('!clear などで新しい会話になったら（SessionStart source=clear）解除する', async () => {
    await start(true);
    await enableByButton();

    fs.appendFileSync(hooks, JSON.stringify({ at: Date.now(), session_id: 's2', hook_event_name: 'SessionStart', source: 'clear' }) + '\n');
    await vi.waitFor(() => expect(h.posts().some((p) => String(p.args.text).includes('全部許可」を解除した'))).toBe(true));

    h.web.calls.length = 0;
    await requestBash(h.client, 'npm test', 'fghij');
    expect(h.verdicts()).toHaveLength(1);
    expect(actionIds(h.posts()[0])).toContain('perm_session');
  });
});

describe('キャッシュのつなぎ止め', () => {
  const harness = useHarnessSlot('app-keepalive-');

  it('!keepalive で状態を見て、off / on で切り替える。Claude には渡さない', async () => {
    const h = await harness.start({
      hookInboxFile: path.join(harness.dir, 'hooks.jsonl'),
      keepalive: { enabled: true, afterMs: 55 * 60_000, max: 6, quiet: undefined },
    });
    h.socket.emit('slack_event', dmEnvelope('!keepalive', { ts: '40.0' }));
    await flush();
    h.socket.emit('slack_event', dmEnvelope('!keepalive off', { ts: '41.0' }));
    await flush();
    h.socket.emit('slack_event', dmEnvelope('!keepalive on', { ts: '42.0' }));
    await flush();

    const posted = h.postTexts();
    expect(posted[0]).toContain('有効');
    expect(posted[1]).toContain('無効');
    expect(posted[2]).toContain('有効');
    expect(h.notifications).toEqual([]);
  });

  it('つなぎ止めで送る文は、Claude に ok とだけ書くよう頼む', () => {
    expect(KEEPALIVE_TEXT).toContain('ok とだけ書く');
  });

  it('つなぎ止めが無いブリッジでは、!keepalive は使えない旨を返す', async () => {
    const h = await harness.start();
    h.socket.emit('slack_event', dmEnvelope('!keepalive', { ts: '43.0' }));
    await flush();

    expect(h.postTexts()).toEqual(['⚠️ このブリッジでは !keepalive を使えない']);
  });
});

describe('使用量の見張りと、想定外の終了からの起動し直しの知らせ', () => {
  const harness = useHarnessSlot('app-usage-');

  it('起動時に crash.json があれば知らせて消す', async () => {
    const crashFile = path.join(harness.dir, 'crash.json');
    fs.writeFileSync(crashFile, JSON.stringify({ at: Date.now(), exit_code: 1, count: 1, max: 3, window_min: 10, resumed: true }));
    const h = await harness.start({ crashFile });

    expect(h.postTexts().some((t) => t.includes('想定外に終了した（exit code 1）'))).toBe(true);
    expect(fs.existsSync(crashFile)).toBe(false);
  });

  it('usage.json の使用量がしきい値を越えたら知らせ、!status に使用量の行を出す', async () => {
    const file = path.join(harness.dir, 'usage.json');
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), five_hour: { used: 85, resets_at: resetsAt } }));
    const h = await harness.start({ usageWatch: { file, usageWarnPct: [80, 95], contextWarnPct: [70, 90], pollMs: 10 } });

    await vi.waitFor(() => expect(h.postTexts().some((t) => t.startsWith('⚠️ 使用量（5 時間枠）が 85%'))).toBe(true));
    h.socket.emit('slack_event', dmEnvelope('!status', { ts: '50.0' }));
    await flush();
    expect(h.postTexts().at(-1)).toContain('使用量: 5 時間枠 85%');
  });
});
