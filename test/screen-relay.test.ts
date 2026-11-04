import { describe, expect, it } from 'vitest';
import { Logger } from '../src/log.js';
import { ScreenRelay, buildChoiceBlocks } from '../src/screen-relay.js';
import type { ConsoleAccess, ConsoleKey } from '../src/console.js';
import { CHROME_CHOICE_SCREEN as CHROME } from './fixtures/screens.js';
import { actionsOf } from './helpers/block-kit.js';

/** 選択肢を出してから押せるまでの期限（src/screen-relay.ts の SNAPSHOT_TTL_MS と同じ値） */
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

/** hasConsole が false なら、画面を読めない環境（コンソールが無い）にする */
function setup(screens: string[], { hasConsole = true }: { hasConsole?: boolean } = {}) {
  const sent: ConsoleKey[][] = [];
  const posts: { kind: string; channel: string; text: string; blocks?: unknown[]; threadTs?: string | undefined }[] = [];
  let t = 0;
  const reads = [...screens];
  const console: ConsoleAccess = {
    read: async () => reads.shift() ?? screens[screens.length - 1] ?? '',
    sendKeys: async (keys) => void sent.push(keys),
    sendCommand: async () => undefined,
  };
  const relay = new ScreenRelay({
    console: hasConsole ? console : undefined,
    logger: new Logger({ stderr: false }),
    now: () => t,
    newId: () => 'snap0001',
    slack: {
      postText: async (channel, text, threadTs) => {
        posts.push({ kind: 'text', channel, text, threadTs });
        return { ts: ['1.0'] };
      },
      postBlocks: async (channel, text, blocks, threadTs) => {
        posts.push({ kind: 'blocks', channel, text, blocks, threadTs });
        return { ts: '2.0' };
      },
      updateBlocks: async (channel, _ts, text) => {
        posts.push({ kind: 'update', channel, text });
      },
    },
  });
  const pressed = { channel: 'C1', ts: '2.0', threadTs: '9.0' };
  return { relay, sent, posts, pressed, advance: (ms: number) => (t += ms) };
}

describe('ScreenRelay', () => {
  it('選択画面なら選択肢をボタン（action_id は重複しない）で出す', async () => {
    const { relay, posts } = setup([CHROME]);
    await relay.show('C1', '9.0');

    expect(posts[0]?.kind).toBe('blocks');
    expect(posts[0]?.threadTs).toBe('9.0');
    expect(actionsOf(posts[0]?.blocks ?? []).map((e) => [e.action_id, e.value])).toEqual([
      ['screen_pick_0', 'snap0001.0'],
      ['screen_pick_1', 'snap0001.1'],
      ['screen_pick_2', 'snap0001.2'],
    ]);
  });

  it('選択画面でなければ画面の末尾を送り、トークンは伏せる', async () => {
    const { relay, posts } = setup(['working...\nSLACK_BOT_TOKEN=xoxb-123-456-abcdef\n']);
    await relay.show('C1', '9.0');
    expect(posts[0]?.kind).toBe('text');
    expect(posts[0]?.text).toContain('選択画面は見つからなかった');
    expect(posts[0]?.text).not.toContain('abcdef');
  });

  it('同じ画面のままなら、カーソルから選んだ選択肢までのキーを送る', async () => {
    const { relay, sent, posts, pressed } = setup([CHROME, CHROME]);
    await relay.show('C1', '9.0');
    await relay.pick('snap0001', 2, pressed, 'U1');

    expect(sent).toEqual([['Down', 'Enter']]);
    expect(posts.at(-1)).toMatchObject({ kind: 'update' });
    expect(posts.at(-1)?.text).toContain("Don't ask again");
  });

  it('画面が変わっていたら何も送らない', async () => {
    const { relay, sent, posts, pressed } = setup([CHROME, 'done\n> \n']);
    await relay.show('C1', '9.0');
    await relay.pick('snap0001', 1, pressed, 'U1');

    expect(sent).toEqual([]);
    expect(posts.at(-1)?.text).toContain('画面が変わっていた');
  });

  it('期限切れの押下では何も送らず、期限切れと返す', async () => {
    const { relay, sent, posts, pressed, advance } = setup([CHROME, CHROME]);
    await relay.show('C1', '9.0');
    advance(SNAPSHOT_TTL_MS + 1);
    await relay.pick('snap0001', 1, pressed, 'U1');

    expect(posts.at(-1)?.text).toContain('期限切れ');
    expect(sent).toEqual([]);
  });

  it('期限切れで押した後に 2 回目を押しても何も送らない', async () => {
    const { relay, sent, pressed, advance } = setup([CHROME, CHROME, CHROME]);
    await relay.show('C1', '9.0');
    advance(SNAPSHOT_TTL_MS + 1);
    await relay.pick('snap0001', 1, pressed, 'U1');
    await relay.pick('snap0001', 1, pressed, 'U1');

    expect(sent).toEqual([]);
  });

  it('画面を読めない環境ならその旨を返す', async () => {
    const { relay, posts } = setup([], { hasConsole: false });
    await relay.show('C1', '9.0');
    expect(posts[0]?.text).toContain('画面を読めない');
  });
});

describe('buildChoiceBlocks', () => {
  it('メッセージの text（通知に出る見出しの 1 行目）も、ブロックと同じくトークンを伏せる', () => {
    const { text, blocks } = buildChoiceBlocks('snap0001', {
      title: ['curl -H "Authorization: Bearer abcdefghijklmnop" ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
      options: [{ label: 'Yes' }, { label: 'No' }],
      cursor: 0,
    });
    expect(text).toContain('Bearer ***');
    expect(text).toContain('ghp_***');
    expect(text).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(blocks)).not.toContain('abcdefghijklmnop');
  });
});
