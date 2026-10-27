import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keepalive, inQuietHours, keepaliveStatusLine, parseQuietHours } from '../src/keepalive.js';
import type { KeepaliveOptions } from '../src/keepalive.js';
import { Logger } from '../src/log.js';

const MIN = 60_000;

describe('parseQuietHours / inQuietHours', () => {
  it('HH:MM-HH:MM を分にする。空・off は時間帯なし', () => {
    expect(parseQuietHours('01:00-07:30')).toEqual({ start: 60, end: 450 });
    expect(parseQuietHours('')).toBeUndefined();
    expect(parseQuietHours('off')).toBeUndefined();
  });

  it('形が違う・始まりと終わりが同じなら投げる', () => {
    expect(() => parseQuietHours('1-7')).toThrow();
    expect(() => parseQuietHours('25:00-07:00')).toThrow();
    expect(() => parseQuietHours('03:00-03:00')).toThrow();
  });

  it('日付をまたぐ時間帯も判定できる', () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 11, h, m);
    const night = { start: 23 * 60, end: 6 * 60 };
    expect(inQuietHours(night, at(23, 30))).toBe(true);
    expect(inQuietHours(night, at(5, 59))).toBe(true);
    expect(inQuietHours(night, at(6, 0))).toBe(false);
    const early = { start: 60, end: 7 * 60 };
    expect(inQuietHours(early, at(0, 59))).toBe(false);
    expect(inQuietHours(early, at(1, 0))).toBe(true);
    expect(inQuietHours(undefined, at(3))).toBe(false);
  });
});

describe('Keepalive', () => {
  let sent: number;
  let busy: boolean;
  let limited: boolean;

  // 昼の 12:00 から始める（送らない時間帯に入らないように）
  const START = new Date(2026, 9, 11, 12, 0).getTime();

  const make = (extra: Partial<KeepaliveOptions> = {}) =>
    new Keepalive({
      enabled: true,
      afterMs: 55 * MIN,
      max: 2,
      quiet: { start: 60, end: 7 * 60 },
      send: () => {
        sent += 1;
        return Promise.resolve();
      },
      isBusy: () => busy,
      isLimited: () => limited,
      logger: new Logger({ stderr: false }),
      now: () => Date.now(),
      ...extra,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    sent = 0;
    busy = false;
    limited = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('最後に動いてから 55 分たったら 1 回送り、応答が終わるたびに次を予定する', async () => {
    const k = make();
    k.requestEnded(Date.now());
    expect(k.status().nextAt?.getTime()).toBe(START + 55 * MIN);
    await vi.advanceTimersByTimeAsync(55 * MIN - 1);
    expect(sent).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toBe(1);
    // つなぎ止めの応答が終わった
    k.requestEnded(Date.now());
    await vi.advanceTimersByTimeAsync(55 * MIN);
    expect(sent).toBe(2);
  });

  it('上限まで送ったら予定を立てない。本物のメッセージで回数が戻る', async () => {
    const k = make();
    for (let i = 0; i < 3; i++) {
      k.requestEnded(Date.now());
      await vi.advanceTimersByTimeAsync(55 * MIN);
    }
    expect(sent).toBe(2);
    expect(k.status().nextAt).toBeUndefined();
    k.resetCount();
    k.requestEnded(Date.now());
    await vi.advanceTimersByTimeAsync(55 * MIN);
    expect(sent).toBe(3);
  });

  it.each([
    ['作業中', () => (busy = true)],
    ['使用量の上限', () => (limited = true)],
  ])('%sなら送らない', async (_label, setup) => {
    const k = make();
    setup();
    k.requestEnded(Date.now());
    await vi.advanceTimersByTimeAsync(55 * MIN);
    expect(sent).toBe(0);
  });

  it('送らない時間帯なら送らない', async () => {
    vi.setSystemTime(new Date(2026, 9, 11, 0, 30));
    const k = make();
    k.requestEnded(Date.now());
    await vi.advanceTimersByTimeAsync(55 * MIN); // 1:25 に入る
    expect(sent).toBe(0);
  });

  it('無効にしたら予定を消し、有効に戻したら最後の応答から予定し直す', async () => {
    const k = make();
    k.requestEnded(Date.now());
    k.setEnabled(false);
    expect(k.status()).toMatchObject({ enabled: false, nextAt: undefined });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    k.setEnabled(true);
    expect(k.status().nextAt?.getTime()).toBe(START + 55 * MIN);
    await vi.advanceTimersByTimeAsync(45 * MIN);
    expect(sent).toBe(1);
  });
});

describe('keepaliveStatusLine', () => {
  it('有効なら次の時刻と回数、無効なら有効にする方法を書く', () => {
    expect(keepaliveStatusLine({ enabled: true, nextAt: new Date(2026, 9, 1, 11, 25), sent: 1, max: 6 })).toBe(
      'キャッシュのつなぎ止め: 有効（次は 2026-10-01 11:25、送った回数 1/6）'
    );
    expect(keepaliveStatusLine({ enabled: true, nextAt: undefined, sent: 6, max: 6 })).toContain('予定なし');
    expect(keepaliveStatusLine({ enabled: false, nextAt: undefined, sent: 0, max: 6 })).toContain('無効');
  });
});
