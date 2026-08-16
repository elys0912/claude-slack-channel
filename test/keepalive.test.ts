import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keepalive, inQuietHours, keepaliveStatusLine, parseQuietHours } from '../src/keepalive.js';
import type { KeepaliveOptions } from '../src/keepalive.js';
import { Logger } from '../src/log.js';
import { MS_PER_MINUTE } from '../src/text.js';

/** テストのつなぎ止めの待ち時間（最後に動いてから 55 分） */
const AFTER_MS = 55 * MS_PER_MINUTE;

describe('parseQuietHours / inQuietHours', () => {
  it('HH:MM-HH:MM を 0 時からの分にする', () => {
    expect(parseQuietHours('01:00-07:30')).toEqual({ start: 60, end: 450 });
  });

  it.each(['', 'off'])('%j なら時間帯なし（undefined）', (text) => {
    expect(parseQuietHours(text)).toBeUndefined();
  });

  it('形が違う・始まりと終わりが同じなら投げる', () => {
    expect(() => parseQuietHours('1-7')).toThrow();
    expect(() => parseQuietHours('25:00-07:00')).toThrow();
    expect(() => parseQuietHours('03:00-03:00')).toThrow();
  });

  const night = { start: 23 * 60, end: 6 * 60 };
  const early = { start: 60, end: 7 * 60 };

  it.each([
    ['日付をまたぐ時間帯の、0 時より前', night, 23, 30, true],
    ['日付をまたぐ時間帯の、終わりの直前', night, 5, 59, true],
    ['日付をまたぐ時間帯の、終わりちょうど（含まない）', night, 6, 0, false],
    ['日付をまたがない時間帯の、始まりの直前', early, 0, 59, false],
    ['日付をまたがない時間帯の、始まりちょうど（含む）', early, 1, 0, true],
  ])('inQuietHours: %s（%j の %i:%i）は %s', (_label, quiet, hour, minute, expected) => {
    expect(inQuietHours(quiet, new Date(2026, 9, 11, hour, minute))).toBe(expected);
  });

  it('inQuietHours: 時間帯が無ければ、どの時刻も false', () => {
    expect(inQuietHours(undefined, new Date(2026, 9, 11, 3, 0))).toBe(false);
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
      afterMs: AFTER_MS,
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
    expect(k.status().nextAt?.getTime()).toBe(START + AFTER_MS);
    await vi.advanceTimersByTimeAsync(AFTER_MS - 1);
    expect(sent).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toBe(1);
    // つなぎ止めの応答が終わった
    k.requestEnded(Date.now());
    await vi.advanceTimersByTimeAsync(AFTER_MS);
    expect(sent).toBe(2);
  });

  /** つなぎ止めを max（2）回送り切るより 1 回多く、応答の終わりと待ち時間を繰り返す */
  const sendUntilMax = async (k: Keepalive): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      k.requestEnded(Date.now());
      await vi.advanceTimersByTimeAsync(AFTER_MS);
    }
  };

  it('上限（max）まで送ったら、それ以上は送らず予定も立てない', async () => {
    const k = make();
    await sendUntilMax(k);
    expect(sent).toBe(2);
    expect(k.status().nextAt).toBeUndefined();
  });

  it('上限まで送った後でも、本物のメッセージ（resetCount）で回数が戻り、また送る', async () => {
    const k = make();
    await sendUntilMax(k);
    k.resetCount();
    k.requestEnded(Date.now());
    await vi.advanceTimersByTimeAsync(AFTER_MS);
    expect(sent).toBe(3);
  });

  it.each([
    ['作業中', () => (busy = true)],
    ['使用量の上限', () => (limited = true)],
  ])('%sなら送らない', async (_label, setup) => {
    const k = make();
    setup();
    k.requestEnded(Date.now());
    await vi.advanceTimersByTimeAsync(AFTER_MS);
    expect(sent).toBe(0);
  });

  it('送らない時間帯なら送らない', async () => {
    vi.setSystemTime(new Date(2026, 9, 11, 0, 30));
    const k = make();
    k.requestEnded(Date.now());
    await vi.advanceTimersByTimeAsync(AFTER_MS); // 1:25 に入る
    expect(sent).toBe(0);
  });

  it('無効にしたら予定を消し、有効に戻したら最後の応答から予定し直す', async () => {
    const k = make();
    k.requestEnded(Date.now());
    k.setEnabled(false);
    expect(k.status()).toMatchObject({ enabled: false, nextAt: undefined });
    const disabledMs = 10 * MS_PER_MINUTE;
    await vi.advanceTimersByTimeAsync(disabledMs);
    k.setEnabled(true);
    expect(k.status().nextAt?.getTime()).toBe(START + AFTER_MS);
    await vi.advanceTimersByTimeAsync(AFTER_MS - disabledMs);
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
