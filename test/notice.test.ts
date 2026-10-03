import { describe, expect, it, vi } from 'vitest';
import { NoticePoster } from '../src/notice.js';
import type { NoticeSlack } from '../src/notice.js';
import { Logger } from '../src/log.js';
import type { ThreadRef } from '../src/types.js';

function fakeSlack(fail = false): NoticeSlack & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    postBlocks: async (...args) => {
      calls.push({ method: 'postBlocks', args });
      if (fail) throw new Error('channel_not_found');
      return { ts: '1.1' };
    },
    postToAll: async (...args) => {
      calls.push({ method: 'postToAll', args });
      if (fail) throw new Error('not_authed');
      return [];
    },
  };
}

describe('NoticePoster', () => {
  it('話しかけられたスレッドがあれば、そのスレッドに出す', async () => {
    const slack = fakeSlack();
    const thread: ThreadRef = { channel: 'D1', threadTs: '70.1' };
    await new NoticePoster(slack, () => thread, new Logger({ stderr: false })).post('hello', [{ type: 'divider' }]);
    expect(slack.calls).toEqual([{ method: 'postBlocks', args: ['D1', 'hello', [{ type: 'divider' }], '70.1'] }]);
  });

  it('スレッドが無ければ許可ユーザー全員の DM に出す。blocks を省略すれば text だけの section にする', async () => {
    const slack = fakeSlack();
    await new NoticePoster(slack, () => undefined, new Logger({ stderr: false })).post('hello');
    expect(slack.calls).toEqual([
      { method: 'postToAll', args: ['hello', [{ type: 'section', text: { type: 'plain_text', text: 'hello' } }]] },
    ]);
  });

  it('投稿に失敗しても投げず、warn に残す', async () => {
    const logger = new Logger({ stderr: false });
    const warn = vi.spyOn(logger, 'warn');
    const thread: ThreadRef = { channel: 'D1', threadTs: '70.1' };
    await expect(new NoticePoster(fakeSlack(true), () => thread, logger).post('hello')).resolves.toBeUndefined();
    await expect(new NoticePoster(fakeSlack(true), () => undefined, logger).post('hello')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('知らせの投稿に失敗');
  });
});
