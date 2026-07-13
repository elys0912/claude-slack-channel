import { describe, expect, it } from 'vitest';
import { Logger } from '../src/log.js';
import { ScreenRelay } from '../src/screen-relay.js';
import type { ConsoleAccess, ConsoleKey } from '../src/console.js';

const CHROME = [
  ' Claude wants to use your browser',
  '    Install extension  Opens the install page in Chrome',
  '  > Not now            Continue without browser tools',
  "    Don't ask again    Revisit anytime with /chrome",
].join('\n');

function setup(screens: string[]) {
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
    console,
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
  return { relay, sent, posts, advance: (ms: number) => (t += ms) };
}

describe('ScreenRelay', () => {
  it('選択画面なら選択肢をボタン（action_id は重複しない）で出す', async () => {
    const { relay, posts } = setup([CHROME]);
    await relay.show('C1', '9.0');

    expect(posts[0]?.kind).toBe('blocks');
    expect(posts[0]?.threadTs).toBe('9.0');
    const actions = (posts[0]?.blocks as { type: string; elements?: { action_id: string; value: string }[] }[]).find(
      (b) => b.type === 'actions'
    );
    expect(actions?.elements?.map((e) => [e.action_id, e.value])).toEqual([
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
    const { relay, sent, posts } = setup([CHROME, CHROME]);
    await relay.show('C1', '9.0');
    await relay.pick('snap0001', 2, { channel: 'C1', ts: '2.0', threadTs: '9.0' }, 'U1');

    expect(sent).toEqual([['Down', 'Enter']]);
    expect(posts.at(-1)).toMatchObject({ kind: 'update' });
    expect(posts.at(-1)?.text).toContain("Don't ask again");
  });

  it('画面が変わっていたら何も送らない', async () => {
    const { relay, sent, posts } = setup([CHROME, 'done\n> \n']);
    await relay.show('C1', '9.0');
    await relay.pick('snap0001', 1, { channel: 'C1', ts: '2.0', threadTs: '9.0' }, 'U1');

    expect(sent).toEqual([]);
    expect(posts.at(-1)?.text).toContain('画面が変わっていた');
  });

  it('期限切れ・2 回目の押下では何も送らない', async () => {
    const { relay, sent, posts, advance } = setup([CHROME, CHROME, CHROME]);
    await relay.show('C1', '9.0');
    advance(5 * 60 * 1000 + 1);
    await relay.pick('snap0001', 1, { channel: 'C1', ts: '2.0', threadTs: '9.0' }, 'U1');
    expect(posts.at(-1)?.text).toContain('期限切れ');

    await relay.pick('snap0001', 1, { channel: 'C1', ts: '2.0', threadTs: '9.0' }, 'U1');
    expect(sent).toEqual([]);
  });

  it('画面を読めない環境ならその旨を返す', async () => {
    const posts: string[] = [];
    const relay = new ScreenRelay({
      console: undefined,
      logger: new Logger({ stderr: false }),
      slack: {
        postText: async (_c, text) => {
          posts.push(text);
          return { ts: [] };
        },
        postBlocks: async () => ({ ts: '' }),
        updateBlocks: async () => undefined,
      },
    });
    await relay.show('C1', '9.0');
    expect(posts[0]).toContain('画面を読めない');
  });
});
