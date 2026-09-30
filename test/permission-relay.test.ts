import { describe, expect, it } from 'vitest';
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
});
