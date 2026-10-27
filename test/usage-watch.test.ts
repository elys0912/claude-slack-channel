import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageWatch, parsePercents, readUsage } from '../src/usage-watch.js';
import { USAGE_FILE } from '../src/statusline.js';
import type { UsageSnapshot } from '../src/statusline.js';
import { Logger } from '../src/log.js';

/** 2026-10-27 12:00（ローカル時刻）。リセット時刻はこれより後にする */
const NOW = new Date(2026, 9, 27, 12, 0).getTime();
const RESET_5H = Math.floor(new Date(2026, 9, 27, 15, 0).getTime() / 1000);
const RESET_7D = Math.floor(new Date(2026, 10, 1, 9, 0).getTime() / 1000);

describe('parsePercents', () => {
  it('カンマ区切りを昇順・重複なしにする。空なら空', () => {
    expect(parsePercents('95, 80,80')).toEqual([80, 95]);
    expect(parsePercents('')).toEqual([]);
  });

  it('1〜100 の整数でなければ投げる', () => {
    expect(() => parsePercents('0')).toThrow(/1〜100/);
    expect(() => parsePercents('80,abc')).toThrow(/1〜100/);
    expect(() => parsePercents('80.5')).toThrow(/1〜100/);
  });
});

describe('UsageWatch', () => {
  let dir: string;
  let file: string;
  let now: number;
  let sent: string[];
  let watch: UsageWatch;

  const write = (snapshot: Omit<UsageSnapshot, 'at'>): void => {
    fs.writeFileSync(file, JSON.stringify({ at: now, ...snapshot }));
  };
  const create = (sessionTag?: string): UsageWatch =>
    new UsageWatch({
      file,
      sessionTag,
      usageWarnPct: [80, 95],
      contextWarnPct: [70, 90],
      notify: async (text) => {
        sent.push(text);
      },
      logger: new Logger({ stderr: false }),
      now: () => now,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-watch-test-'));
    file = path.join(dir, USAGE_FILE);
    now = NOW;
    sent = [];
    watch = create();
  });

  afterEach(() => {
    watch.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('使用量は枠ごとにしきい値を越えたときだけ 1 回ずつ知らせ、最後のしきい値は止める目安を添える', async () => {
    write({ five_hour: { used: 79.9, resets_at: RESET_5H } });
    await watch.check();
    expect(sent).toEqual([]);

    write({ five_hour: { used: 81, resets_at: RESET_5H } });
    await watch.check();
    await watch.check();
    expect(sent).toEqual(['⚠️ 使用量（5 時間枠）が 81%（リセット 2026-10-27 15:00）']);

    write({ five_hour: { used: 96, resets_at: RESET_5H }, seven_day: { used: 85, resets_at: RESET_7D } });
    await watch.check();
    expect(sent.slice(1)).toEqual([
      '🛑 使用量（5 時間枠）が 96%。重い作業は区切りのよいところで止める（リセット 2026-10-27 15:00）',
      '⚠️ 使用量（7 日枠）が 85%（リセット 2026-11-01 09:00）',
    ]);
  });

  it('枠がリセットされた後は、同じしきい値でもまた知らせる。リセット時刻を過ぎた古い記録では知らせない', async () => {
    write({ five_hour: { used: 81, resets_at: RESET_5H } });
    await watch.check();

    now = RESET_5H * 1000 + 1;
    await watch.check();
    expect(sent).toHaveLength(1);
    expect(watch.isHigh()).toBe(false);

    const next = RESET_5H + 5 * 3600;
    write({ five_hour: { used: 82, resets_at: next } });
    await watch.check();
    expect(sent).toHaveLength(2);
    expect(watch.isHigh()).toBe(true);
  });

  it('コンテキストは会話ごとに 1 回ずつ知らせ、contextReset か会話が替わると数え直す', async () => {
    write({ session_id: 's1', context: { used: 72 } });
    await watch.check();
    await watch.check();
    write({ session_id: 's1', context: { used: 91 } });
    await watch.check();
    expect(sent).toEqual([
      'ℹ️ コンテキストが 72%。区切りのよいところで !compact を検討する',
      '⚠️ コンテキストが 91%。!compact（要約して縮める）か !clear（新しい会話）を勧める',
    ]);

    watch.contextReset();
    write({ session_id: 's1', context: { used: 75 } });
    await watch.check();
    write({ session_id: 's2', context: { used: 76 } });
    await watch.check();
    expect(sent.slice(2)).toEqual([
      'ℹ️ コンテキストが 75%。区切りのよいところで !compact を検討する',
      'ℹ️ コンテキストが 76%。区切りのよいところで !compact を検討する',
    ]);
  });

  it('上限に当たった後、いちばん使っている枠のリセット時刻を過ぎたら 1 回だけ戻ったと知らせる', async () => {
    write({ five_hour: { used: 100, resets_at: RESET_5H }, seven_day: { used: 60, resets_at: RESET_7D } });
    await watch.check();
    watch.limitHit();
    sent = [];

    now = RESET_5H * 1000 - 1;
    await watch.check();
    expect(sent).toEqual([]);

    now = RESET_5H * 1000;
    await watch.check();
    await watch.check();
    expect(sent).toEqual(['✅ 使用量の上限が戻った（2026-10-27 15:00 にリセット）。続けるなら指示を送る']);
  });

  it('上限の後に応答が終われば（limitCleared）、戻ったとは知らせない', async () => {
    write({ five_hour: { used: 100, resets_at: RESET_5H } });
    await watch.check();
    watch.limitHit();
    watch.limitCleared();
    sent = [];

    now = RESET_5H * 1000;
    await watch.check();
    expect(sent).toEqual([]);
  });

  it('session_tag が違う記録は読まない', async () => {
    watch = create('mine');
    write({ session_tag: 'other', five_hour: { used: 90, resets_at: RESET_5H } });
    await watch.check();
    expect(sent).toEqual([]);
    expect(watch.statusLine()).toBeUndefined();
  });

  it('!status の行は、リセット前の枠とコンテキストを書く', async () => {
    write({ context: { used: 42.4 }, five_hour: { used: 63.5, resets_at: RESET_5H } });
    await watch.check();
    expect(watch.statusLine()).toBe('使用量: 5 時間枠 64%（リセット 2026-10-27 15:00）・コンテキスト 42%（2026-10-27 12:00 時点）');
  });

  it('知らせが投げても見張りは止まらない', async () => {
    watch = new UsageWatch({
      file,
      usageWarnPct: [80],
      contextWarnPct: [],
      notify: async () => {
        throw new Error('network');
      },
      logger: new Logger({ stderr: false }),
      now: () => now,
    });
    write({ five_hour: { used: 90, resets_at: RESET_5H } });
    await expect(watch.check()).resolves.toBeUndefined();
  });

  it('readUsage は無い・壊れたファイルで undefined', () => {
    expect(readUsage(file)).toBeUndefined();
    fs.writeFileSync(file, '{ broken');
    expect(readUsage(file)).toBeUndefined();
  });
});
