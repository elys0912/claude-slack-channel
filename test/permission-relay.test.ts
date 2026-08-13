import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionRelay } from '../src/permission-relay.js';
import type { RelayClaude, RelaySlack } from '../src/permission-relay.js';
import { PendingPermissions } from '../src/permission.js';
import type { PermissionRequest } from '../src/permission.js';
import { Logger } from '../src/log.js';
import type { Verdict } from '../src/types.js';

const REQ: PermissionRequest = {
  request_id: 'abcde',
  tool_name: 'Write',
  description: 'Write hello.txt',
  input_preview: '{"file_path":"hello.txt"}',
};

/** 保留の期限。期限切れで自動 deny するタイマーもこの長さになる */
const TTL_MS = 1000;
/** 期限を十分に過ぎた時刻・経過時間 */
const WELL_PAST_TTL_MS = TTL_MS * 5;

interface SetupOptions {
  now?: () => number;
  /** スレッド返信（postBlocks）の結果。既定は ts '2.0' が返る */
  reply?: 'ok' | 'throw' | 'empty';
  /** 既定の偽物から差し替える操作 */
  slack?: Partial<RelaySlack>;
  claude?: Partial<RelayClaude>;
}

function setup({ now = () => 0, reply = 'ok', slack, claude }: SetupOptions = {}) {
  const posts: { text: string; threadFor: (ch: string) => string | undefined }[] = [];
  const replies: { channel: string; threadTs: string | undefined }[] = [];
  const updates: { channel: string; ts: string; text: string }[] = [];
  const verdicts: Verdict[] = [];

  const fakeSlack: RelaySlack = {
    postToAll: async (text, _blocks, threadFor) => {
      posts.push({ text, threadFor: threadFor ?? (() => undefined) });
      return [
        { channel: 'D1', ts: '1.0' },
        { channel: 'D2', ts: '' }, // 送信に失敗したチャンネル
      ];
    },
    postBlocks: async (channel, _text, _blocks, threadTs) => {
      if (reply === 'throw') throw new Error('not_in_channel');
      replies.push({ channel, threadTs });
      return { ts: reply === 'empty' ? '' : '2.0' };
    },
    updateBlocks: async (channel, ts, text) => {
      updates.push({ channel, ts, text });
    },
    ...slack,
  };
  const fakeClaude: RelayClaude = {
    sendVerdict: async (v) => {
      verdicts.push(v);
    },
    ...claude,
  };

  const logger = new Logger({ stderr: false });
  const pending = new PendingPermissions(TTL_MS, now);
  const relay = new PermissionRelay(fakeSlack, fakeClaude, logger, pending);
  return { relay, posts, replies, updates, verdicts, logger };
}

/** 配信先 1 件（D1）だけに届いたことにする postToAll */
const postToD1Only: RelaySlack['postToAll'] = async () => [{ channel: 'D1', ts: '1.0' }];

/** REQ のボタンを U1 が押す。at は押されたメッセージ（既定は DM 配信の D1） */
function pressButton(
  relay: PermissionRelay,
  behavior: Verdict['behavior'],
  at: { channel: string; ts: string } = { channel: 'D1', ts: '1.0' }
): Promise<void> {
  return relay.answerByButton({ requestId: 'abcde', behavior }, 'U1', at);
}

describe('PermissionRelay', () => {
  it('request は最後に話しかけられたスレッドにだけ返信する（DM には配らない）', async () => {
    const { relay, posts, replies } = setup();
    relay.rememberThread('D1', '9.9');
    relay.rememberThread('C1', '7.7');
    await relay.request(REQ);

    expect(replies).toEqual([{ channel: 'C1', threadTs: '7.7' }]);
    expect(posts).toHaveLength(0);
    expect(relay.lookup('abcde')).toEqual(REQ);
  });

  it('スレッドに返信した request は、回答後にその 1 通だけを書き換える', async () => {
    const { relay, updates } = setup();
    relay.rememberThread('C1', '7.7');
    await relay.request(REQ);
    await pressButton(relay, 'allow', { channel: 'C1', ts: '2.0' });

    expect(updates).toEqual([expect.objectContaining({ channel: 'C1', ts: '2.0' })]);
  });

  it('まだ話しかけられていなければ、DM 全体に配信する', async () => {
    const { relay, posts, replies } = setup();
    await relay.request(REQ);

    expect(replies).toHaveLength(0);
    expect(posts).toHaveLength(1);
  });

  it.each([
    ['投げた', 'throw' as const],
    ['ts が返らなかった', 'empty' as const],
  ])('スレッドへの返信が%sら、覚えておいた DM のスレッドを使って DM 全体に配信する', async (_label, reply) => {
    const { relay, posts, verdicts } = setup({ reply });
    relay.rememberThread('D1', '9.9');
    relay.rememberThread('C1', '7.7');
    await relay.request(REQ);

    expect(posts).toHaveLength(1);
    expect(posts[0]?.threadFor('D1')).toBe('9.9');
    expect(posts[0]?.threadFor('D2')).toBeUndefined();
    // DM に届いたので自動 deny はしない
    expect(verdicts).toEqual([]);
  });

  it('ボタンで回答すると Claude に送り、投稿済みのメッセージだけを書き換える', async () => {
    const { relay, updates, verdicts } = setup();
    await relay.request(REQ);
    await pressButton(relay, 'allow');

    expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'allow' }]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ channel: 'D1', ts: '1.0' });
    expect(updates[0]?.text).toContain('Allowed');
    expect(relay.lookup('abcde')).toBeUndefined();
  });

  it('保留中と同じ ID の request が再び届いても、出し直さず最初のボタンで答えられる', async () => {
    const { relay, posts, verdicts, updates } = setup();
    await relay.request(REQ);
    await relay.request({ ...REQ, description: 'resent' });
    expect(posts).toHaveLength(1);
    expect(relay.lookup('abcde')).toEqual(REQ);

    await pressButton(relay, 'deny');
    expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'deny' }]);
    expect(updates).toEqual([expect.objectContaining({ channel: 'D1', ts: '1.0' })]);
  });

  describe('回答を Claude に送れなかったとき', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([
      ['ボタン', (relay: PermissionRelay) => pressButton(relay, 'allow')],
      ['テキスト', (relay: PermissionRelay) => relay.answerByText({ requestId: 'abcde', behavior: 'allow' }, 'U1')],
    ])('%sの回答を Claude に送れなかったら、投げずにメッセージを「送れなかった」表示にし、期限のタイマーも止める', async (_label, answer) => {
      const sent: Verdict[] = [];
      const { relay, updates } = setup({
        slack: { postToAll: postToD1Only },
        claude: {
          sendVerdict: async (v) => {
            sent.push(v);
            throw new Error('not connected');
          },
        },
      });
      await relay.request(REQ);
      updates.length = 0;
      await expect(answer(relay)).resolves.not.toThrow();

      expect(updates.map((u) => u.text)).toEqual([expect.stringContaining('Allow を Claude に送れなかった')]);
      expect(relay.lookup('abcde')).toBeUndefined();
      // 期限が来ても deny を重ねて送らない（Claude には既に届いていない）
      await vi.advanceTimersByTimeAsync(WELL_PAST_TTL_MS);
      expect(sent).toEqual([{ requestId: 'abcde', behavior: 'allow' }]);
    });
  });

  it('期限切れのボタンは Claude に送らず、押されたメッセージを期限切れ表示にする', async () => {
    let t = 0;
    const { relay, updates, verdicts } = setup({ now: () => t });
    await relay.request(REQ);
    t = WELL_PAST_TTL_MS;
    await pressButton(relay, 'allow');

    expect(verdicts).toEqual([]);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.text).toContain('expired');
  });

  it('テキストの回答は、手元に記録が無い ID なら Claude に送らず false を返す', async () => {
    const { relay, updates, verdicts } = setup();
    expect(await relay.answerByText({ requestId: 'zzzzz', behavior: 'deny' }, 'U1')).toBe(false);

    expect(verdicts).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('テキストの回答でも、期限切れの ID は Claude に送らない', async () => {
    let t = 0;
    const { relay, verdicts } = setup({ now: () => t });
    await relay.request(REQ);
    t = WELL_PAST_TTL_MS;
    expect(await relay.answerByText({ requestId: 'abcde', behavior: 'allow' }, 'U1')).toBe(false);
    expect(verdicts).toEqual([]);
  });

  it('テキストの回答でも、記録がある ID ならメッセージを書き換える', async () => {
    const { relay, updates } = setup();
    await relay.request(REQ);
    expect(await relay.answerByText({ requestId: 'abcde', behavior: 'deny' }, 'U1')).toBe(true);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.text).toContain('Denied');
  });

  describe('denyAll', () => {
    it('保留中の全件に deny を送り、メッセージを書き換え、回答済みのものには送らない', async () => {
      const { relay, updates, verdicts } = setup();
      await relay.request(REQ);
      await relay.request({ ...REQ, request_id: 'fghij' });
      await relay.request({ ...REQ, request_id: 'kmnop' });
      await relay.answerByText({ requestId: 'kmnop', behavior: 'allow' }, 'U1');
      updates.length = 0;
      verdicts.length = 0;

      await relay.denyAll('ブリッジ終了');
      expect(verdicts).toEqual([
        { requestId: 'abcde', behavior: 'deny' },
        { requestId: 'fghij', behavior: 'deny' },
      ]);
      expect(updates.map((u) => u.text)).toEqual([
        expect.stringContaining('ブリッジ終了のため自動で拒否した'),
        expect.stringContaining('ブリッジ終了のため自動で拒否した'),
      ]);
      expect(relay.lookup('abcde')).toBeUndefined();

      // 2 回目は何も送らない
      await relay.denyAll('ブリッジ終了');
      expect(verdicts).toHaveLength(2);
    });

    it('deny の送信や書き換えに失敗しても、残りを続けて投げない', async () => {
      const verdicts: string[] = [];
      const { relay } = setup({
        slack: {
          postToAll: postToD1Only,
          updateBlocks: async () => {
            throw new Error('slack down');
          },
        },
        claude: {
          sendVerdict: async (v) => {
            verdicts.push(v.requestId);
            if (v.requestId === 'abcde') throw new Error('not connected');
          },
        },
      });
      await relay.request(REQ);
      await relay.request({ ...REQ, request_id: 'fghij' });
      await expect(relay.denyAll('ブリッジ終了')).resolves.toBeUndefined();
      expect(verdicts).toEqual(['abcde', 'fghij']);
    });
  });

  describe('配信先が 0 件', () => {
    describe('タイマーを進めて確かめるもの', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it.each([
        ['全チャンネルで失敗', [{ channel: 'D1', ts: '' }, { channel: 'D2', ts: '' }]],
        ['DM チャンネルが無い', []],
      ])('%s なら、その場で deny を送って保留から消し、error を残す', async (_label, results) => {
        const { relay, verdicts, logger } = setup({ slack: { postToAll: async () => results } });
        const errorSpy = vi.spyOn(logger, 'error');
        await expect(relay.request(REQ)).resolves.toBeUndefined();

        expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'deny' }]);
        expect(relay.lookup('abcde')).toBeUndefined();
        expect(errorSpy).toHaveBeenCalled();
        // 期限が来ても重ねて送らない
        await vi.advanceTimersByTimeAsync(WELL_PAST_TTL_MS);
        expect(verdicts).toHaveLength(1);
      });
    });

    it('postToAll が投げても、deny を送って投げない', async () => {
      const { relay, verdicts } = setup({
        slack: {
          postToAll: async () => {
            throw new Error('boom');
          },
        },
      });
      await expect(relay.request(REQ)).resolves.toBeUndefined();
      expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'deny' }]);
    });
  });

  describe('期限切れの自動 deny', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('TTL を過ぎたら Claude に deny を送り、投稿済みのメッセージを自動拒否の表示にして保留から消す', async () => {
      const { relay, updates, verdicts } = setup();
      await relay.request(REQ);
      await vi.advanceTimersByTimeAsync(TTL_MS - 1);
      expect(verdicts).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'deny' }]);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ channel: 'D1', ts: '1.0' });
      expect(updates[0]?.text).toContain('期限切れのため自動で拒否した');
      expect(relay.lookup('abcde')).toBeUndefined();

      // 自動 deny の後のボタンは Claude に送らない
      await pressButton(relay, 'allow');
      expect(verdicts).toHaveLength(1);
    });

    it('期限前に回答済みなら、期限が来ても deny を重ねて送らない', async () => {
      const { relay, updates, verdicts } = setup();
      await relay.request(REQ);
      expect(await relay.answerByText({ requestId: 'abcde', behavior: 'allow' }, 'U1')).toBe(true);
      await vi.advanceTimersByTimeAsync(WELL_PAST_TTL_MS);

      expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'allow' }]);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.text).toContain('Allowed');
    });

    it('期限切れ後・タイマー前に押されたボタンは送らず、その後のタイマーで deny を 1 回だけ送る', async () => {
      let t = 0;
      const { relay, verdicts } = setup({ now: () => t });
      await relay.request(REQ);
      t = WELL_PAST_TTL_MS;
      await pressButton(relay, 'allow');
      expect(verdicts).toEqual([]);

      await vi.advanceTimersByTimeAsync(TTL_MS);
      expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'deny' }]);
    });

    it('deny の送信に失敗しても投げず、メッセージの書き換えは行う', async () => {
      const { relay, updates } = setup({
        slack: { postToAll: postToD1Only },
        claude: {
          sendVerdict: async () => {
            throw new Error('not connected');
          },
        },
      });
      await relay.request(REQ);
      await vi.advanceTimersByTimeAsync(TTL_MS);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.text).toContain('自動で拒否した');
    });
  });
});
