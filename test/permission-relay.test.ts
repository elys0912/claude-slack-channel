import { afterEach, describe, expect, it, vi } from 'vitest';
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

function setup(now: () => number = () => 0) {
  const posts: { text: string; threadFor: (ch: string) => string | undefined }[] = [];
  const updates: { channel: string; ts: string; text: string }[] = [];
  const verdicts: Verdict[] = [];

  const slack: RelaySlack = {
    postToAll: async (text, _blocks, threadFor) => {
      posts.push({ text, threadFor: threadFor ?? (() => undefined) });
      return [
        { channel: 'D1', ts: '1.0' },
        { channel: 'D2', ts: '' }, // 送信に失敗したチャンネル
      ];
    },
    updateBlocks: async (channel, ts, text) => {
      updates.push({ channel, ts, text });
    },
  };
  const claude: RelayClaude = {
    sendVerdict: async (v) => {
      verdicts.push(v);
    },
  };

  const pending = new PendingPermissions(1000, now);
  const relay = new PermissionRelay(slack, claude, new Logger({ stderr: false }), pending);
  return { relay, posts, updates, verdicts };
}

describe('PermissionRelay', () => {
  it('request は覚えておいたスレッドに投稿する', async () => {
    const { relay, posts } = setup();
    relay.rememberThread('D1', '9.9');
    await relay.request(REQ);

    expect(posts).toHaveLength(1);
    expect(posts[0]?.threadFor('D1')).toBe('9.9');
    expect(posts[0]?.threadFor('D2')).toBeUndefined();
    expect(relay.lookup('abcde')).toEqual(REQ);
  });

  it('ボタンで回答すると Claude に送り、投稿済みのメッセージだけを書き換える', async () => {
    const { relay, updates, verdicts } = setup();
    await relay.request(REQ);
    await relay.answerByButton({ requestId: 'abcde', behavior: 'allow' }, 'U1', { channel: 'D1', ts: '1.0' });

    expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'allow' }]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ channel: 'D1', ts: '1.0' });
    expect(updates[0]?.text).toContain('Allowed');
    expect(relay.lookup('abcde')).toBeUndefined();
  });

  it('期限切れのボタンは Claude に送らず、押されたメッセージを期限切れ表示にする', async () => {
    let t = 0;
    const { relay, updates, verdicts } = setup(() => t);
    await relay.request(REQ);
    t = 5000;
    await relay.answerByButton({ requestId: 'abcde', behavior: 'allow' }, 'U1', { channel: 'D1', ts: '1.0' });

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
    const { relay, verdicts } = setup(() => t);
    await relay.request(REQ);
    t = 5000;
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

  describe('期限切れの自動 deny', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('TTL を過ぎたら Claude に deny を送り、投稿済みのメッセージを自動拒否の表示にして保留から消す', async () => {
      vi.useFakeTimers();
      const { relay, updates, verdicts } = setup();
      await relay.request(REQ);
      await vi.advanceTimersByTimeAsync(999);
      expect(verdicts).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'deny' }]);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ channel: 'D1', ts: '1.0' });
      expect(updates[0]?.text).toContain('期限切れのため自動で拒否した');
      expect(relay.lookup('abcde')).toBeUndefined();

      // 自動 deny の後のボタンは Claude に送らない
      await relay.answerByButton({ requestId: 'abcde', behavior: 'allow' }, 'U1', { channel: 'D1', ts: '1.0' });
      expect(verdicts).toHaveLength(1);
    });

    it('期限前に回答済みなら、期限が来ても deny を重ねて送らない', async () => {
      vi.useFakeTimers();
      const { relay, updates, verdicts } = setup();
      await relay.request(REQ);
      expect(await relay.answerByText({ requestId: 'abcde', behavior: 'allow' }, 'U1')).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);

      expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'allow' }]);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.text).toContain('Allowed');
    });

    it('期限切れ後・タイマー前に押されたボタンは送らず、その後のタイマーで deny を 1 回だけ送る', async () => {
      vi.useFakeTimers();
      let t = 0;
      const { relay, verdicts } = setup(() => t);
      await relay.request(REQ);
      t = 5000;
      await relay.answerByButton({ requestId: 'abcde', behavior: 'allow' }, 'U1', { channel: 'D1', ts: '1.0' });
      expect(verdicts).toEqual([]);

      await vi.advanceTimersByTimeAsync(1000);
      expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'deny' }]);
    });

    it('deny の送信に失敗しても投げず、メッセージの書き換えは行う', async () => {
      vi.useFakeTimers();
      const updates: string[] = [];
      const relay = new PermissionRelay(
        {
          postToAll: async () => [{ channel: 'D1', ts: '1.0' }],
          updateBlocks: async (_channel, _ts, text) => void updates.push(text),
        },
        {
          sendVerdict: async () => {
            throw new Error('not connected');
          },
        },
        new Logger({ stderr: false }),
        new PendingPermissions(1000, () => 0)
      );
      await relay.request(REQ);
      await vi.advanceTimersByTimeAsync(1000);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toContain('自動で拒否した');
    });
  });
});
