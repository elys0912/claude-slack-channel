import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/log.js';
import {
  DEFAULT_REPLY_TIMEOUT_MIN,
  ResponseWatchdog,
  buildNoResponseText,
  replyTimeoutMs,
} from '../src/watchdog.js';
import type { WatchdogTarget } from '../src/watchdog.js';
import { MS_PER_MINUTE } from '../src/text.js';

/** テストの見張りの待ち時間（1 分。知らせの minutes は 1 になる） */
const TIMEOUT_MS = MS_PER_MINUTE;
/** 待ち時間を十分に過ぎた後まで進める量（知らせが 2 回目以降に出ないことを確かめる） */
const LONG_AFTER_MS = TIMEOUT_MS * 10;

describe('ResponseWatchdog', () => {
  let notified: { target: WatchdogTarget; minutes: number }[];

  function make(timeoutMs = TIMEOUT_MS, notify?: () => Promise<void>): ResponseWatchdog {
    return new ResponseWatchdog({
      timeoutMs,
      logger: new Logger({ stderr: false }),
      notify:
        notify ??
        (async (target, minutes) => {
          notified.push({ target, minutes });
        }),
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    notified = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['有効', TIMEOUT_MS],
    ['無効（0）', 0],
  ])('見張りが%sでも、isWaiting は渡してから応答があるまで true で、待ち時間を過ぎても変わらない', async (_label, timeoutMs) => {
    const w = make(timeoutMs);
    expect(w.isWaiting()).toBe(false);
    w.delivered({ channel: 'C1', threadTs: '1.0' });
    expect(w.isWaiting()).toBe(true);
    expect(w.waitingSince()).toBeTypeOf('number');
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(w.isWaiting()).toBe(true);
  });

  it.each([
    ['有効', TIMEOUT_MS],
    ['無効（0）', 0],
  ])('見張りが%sでも、activity があれば待っていない状態に戻る', (_label, timeoutMs) => {
    const w = make(timeoutMs);
    w.delivered({ channel: 'C1', threadTs: '1.0' });
    w.activity();
    expect(w.isWaiting()).toBe(false);
    expect(w.waitingSince()).toBeUndefined();
  });

  it('応答が無いまま待ち時間を過ぎたら、最後のスレッドに 1 回だけ知らせる', async () => {
    const w = make();
    w.delivered({ channel: 'C1', threadTs: '1.0' });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(notified).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(notified).toEqual([{ target: { channel: 'C1', threadTs: '1.0' }, minutes: 1 }]);

    await vi.advanceTimersByTimeAsync(LONG_AFTER_MS);
    expect(notified).toHaveLength(1);
  });

  it('待ち時間内に activity があれば知らせない', async () => {
    const w = make();
    w.delivered({ channel: 'C1', threadTs: '1.0' });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS / 2);
    w.activity();
    await vi.advanceTimersByTimeAsync(LONG_AFTER_MS);
    expect(notified).toEqual([]);
  });

  it('新しいメッセージが届いたら待ち時間を数え直し、見張るのは最後の 1 件だけ', async () => {
    // 1 件目から数えれば待ち時間を過ぎるが、2 件目からは過ぎていない時点で確かめる
    const partMs = (TIMEOUT_MS * 2) / 3;
    const w = make();
    w.delivered({ channel: 'C1', threadTs: '1.0' });
    await vi.advanceTimersByTimeAsync(partMs);
    w.delivered({ channel: 'D1', threadTs: '2.0' });
    await vi.advanceTimersByTimeAsync(partMs);
    expect(notified).toEqual([]);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - partMs);
    expect(notified.map((n) => n.target)).toEqual([{ channel: 'D1', threadTs: '2.0' }]);
  });

  it('timeoutMs が 0 なら見張らない', async () => {
    const w = make(0);
    w.delivered({ channel: 'C1', threadTs: '1.0' });
    await vi.advanceTimersByTimeAsync(LONG_AFTER_MS);
    expect(notified).toEqual([]);
  });

  it('stop したら知らせない', async () => {
    const w = make();
    w.delivered({ channel: 'C1', threadTs: '1.0' });
    w.stop();
    await vi.advanceTimersByTimeAsync(LONG_AFTER_MS);
    expect(notified).toEqual([]);
  });

  it('通知が投げても例外を外に出さず、次の見張りは続けられる', async () => {
    let calls = 0;
    const w = make(1000, async () => {
      calls += 1;
      throw new Error('slack down');
    });
    w.delivered({ channel: 'C1', threadTs: '1.0' });
    await vi.advanceTimersByTimeAsync(1000);
    w.delivered({ channel: 'C1', threadTs: '2.0' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
  });
});

describe('buildNoResponseText', () => {
  it('経過分と、Slack に中継されない確認画面の可能性を書く', () => {
    const text = buildNoResponseText(5);
    expect(text).toContain('5 分応答が無い');
    expect(text).toContain('Slack には中継されない');
    expect(text).toContain('使用量の上限');
  });
});

describe('replyTimeoutMs', () => {
  it.each([
    [undefined, DEFAULT_REPLY_TIMEOUT_MIN * MS_PER_MINUTE],
    ['', DEFAULT_REPLY_TIMEOUT_MIN * MS_PER_MINUTE],
    ['10', 10 * MS_PER_MINUTE],
    ['0.5', 0.5 * MS_PER_MINUTE],
    ['0', 0],
    ['-1', DEFAULT_REPLY_TIMEOUT_MIN * MS_PER_MINUTE],
    ['abc', DEFAULT_REPLY_TIMEOUT_MIN * MS_PER_MINUTE],
  ])('SLACK_CHANNEL_REPLY_TIMEOUT_MIN=%s なら %d ms', (value, expected) => {
    const env: NodeJS.ProcessEnv = value === undefined ? {} : { SLACK_CHANNEL_REPLY_TIMEOUT_MIN: value };
    expect(replyTimeoutMs(env)).toBe(expected);
  });
});
