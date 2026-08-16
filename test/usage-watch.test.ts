import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageWatch, parsePercents, readUsage } from '../src/usage-watch.js';
import type { UsageWatchOptions } from '../src/usage-watch.js';
import { USAGE_FILE } from '../src/statusline.js';
import type { UsageSnapshot } from '../src/statusline.js';
import { Logger } from '../src/log.js';
import { useTempDir } from './helpers/temp-dir.js';

/** 2026-10-27 12:00（ローカル時刻）。リセット時刻はこれより後にする */
const NOW = new Date(2026, 9, 27, 12, 0).getTime();
/** usage.json の resets_at は秒 */
const MS_PER_SECOND = 1000;
const RESET_5H = Math.floor(new Date(2026, 9, 27, 15, 0).getTime() / MS_PER_SECOND);
const RESET_7D = Math.floor(new Date(2026, 10, 1, 9, 0).getTime() / MS_PER_SECOND);

/** 5 時間枠のリセット時刻から offsetMs ずらした時刻（ミリ秒） */
function atReset(offsetMs: number): number {
  return RESET_5H * MS_PER_SECOND + offsetMs;
}

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
  const tempDir = useTempDir('usage-watch-test-');
  let file: string;
  let now: number;
  let sent: string[];
  let watch: UsageWatch;

  const write = (snapshot: Omit<UsageSnapshot, 'at'>): void => {
    fs.writeFileSync(file, JSON.stringify({ at: now, ...snapshot }));
  };
  const create = (
    opts: Partial<Pick<UsageWatchOptions, 'sessionTag' | 'notify' | 'usageWarnPct' | 'contextWarnPct'>> = {}
  ): UsageWatch =>
    new UsageWatch({
      file,
      sessionTag: opts.sessionTag,
      usageWarnPct: opts.usageWarnPct ?? [80, 95],
      contextWarnPct: opts.contextWarnPct ?? [70, 90],
      notify:
        opts.notify ??
        (async (text) => {
          sent.push(text);
        }),
      logger: new Logger({ stderr: false }),
      now: () => now,
    });
  /** 5 時間枠を使い切って上限に当たった状態にし、それまでの知らせを捨てる */
  const hitLimitOn5h = async (): Promise<void> => {
    write({ five_hour: { used: 100, resets_at: RESET_5H }, seven_day: { used: 60, resets_at: RESET_7D } });
    await watch.check();
    watch.limitHit();
    sent = [];
  };

  beforeEach(() => {
    file = path.join(tempDir(), USAGE_FILE);
    now = NOW;
    sent = [];
    watch = create();
  });

  afterEach(() => {
    watch.stop();
  });

  it('使用量はしきい値を越えるまで知らせず、越えたら同じしきい値は 1 回だけ知らせる', async () => {
    write({ five_hour: { used: 79.9, resets_at: RESET_5H } });
    await watch.check();
    expect(sent).toEqual([]);

    write({ five_hour: { used: 81, resets_at: RESET_5H } });
    await watch.check();
    await watch.check();
    expect(sent).toEqual(['⚠️ 使用量（5 時間枠）が 81%（リセット 2026-10-27 15:00）']);
  });

  it('使用量は枠ごとに知らせ、最後のしきい値を越えた枠には止める目安を添える', async () => {
    write({ five_hour: { used: 96, resets_at: RESET_5H }, seven_day: { used: 85, resets_at: RESET_7D } });
    await watch.check();
    expect(sent).toEqual([
      '🛑 使用量（5 時間枠）が 96%。重い作業は区切りのよいところで止める（リセット 2026-10-27 15:00）',
      '⚠️ 使用量（7 日枠）が 85%（リセット 2026-11-01 09:00）',
    ]);
  });

  it('リセット時刻を過ぎた古い記録では知らせず、isHigh も false', async () => {
    write({ five_hour: { used: 81, resets_at: RESET_5H } });
    await watch.check();

    now = atReset(1);
    await watch.check();
    expect(sent).toHaveLength(1);
    expect(watch.isHigh()).toBe(false);
  });

  it('枠がリセットされた後は、同じしきい値でもまた知らせる', async () => {
    write({ five_hour: { used: 81, resets_at: RESET_5H } });
    await watch.check();

    now = atReset(1);
    write({ five_hour: { used: 82, resets_at: RESET_5H + 5 * 3600 } });
    await watch.check();
    expect(sent).toHaveLength(2);
    expect(watch.isHigh()).toBe(true);
  });

  it('コンテキストは同じ会話の中ではしきい値ごとに 1 回ずつ知らせる', async () => {
    write({ session_id: 's1', context: { used: 72 } });
    await watch.check();
    await watch.check();
    write({ session_id: 's1', context: { used: 91 } });
    await watch.check();
    expect(sent).toEqual([
      'ℹ️ コンテキストが 72%。区切りのよいところで !compact を検討する',
      '⚠️ コンテキストが 91%。!compact（要約して縮める）か !clear（新しい会話）を勧める',
    ]);
  });

  it('contextReset の後は、同じ会話でもコンテキストを数え直す', async () => {
    write({ session_id: 's1', context: { used: 72 } });
    await watch.check();

    watch.contextReset();
    write({ session_id: 's1', context: { used: 75 } });
    await watch.check();
    expect(sent.slice(1)).toEqual(['ℹ️ コンテキストが 75%。区切りのよいところで !compact を検討する']);
  });

  it('会話が替わると、コンテキストを数え直す', async () => {
    write({ session_id: 's1', context: { used: 72 } });
    await watch.check();

    write({ session_id: 's2', context: { used: 76 } });
    await watch.check();
    expect(sent.slice(1)).toEqual(['ℹ️ コンテキストが 76%。区切りのよいところで !compact を検討する']);
  });

  it('上限に当たった後、いちばん使っている枠のリセット時刻の前は、戻ったと知らせない', async () => {
    await hitLimitOn5h();

    now = atReset(-1);
    await watch.check();
    expect(sent).toEqual([]);
  });

  it('上限に当たった後、いちばん使っている枠のリセット時刻を過ぎたら 1 回だけ戻ったと知らせる', async () => {
    await hitLimitOn5h();

    now = atReset(0);
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

    now = atReset(0);
    await watch.check();
    expect(sent).toEqual([]);
  });

  it('session_tag が違う記録は読まない', async () => {
    watch = create({ sessionTag: 'mine' });
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
    watch = create({
      usageWarnPct: [80],
      contextWarnPct: [],
      notify: async () => {
        throw new Error('network');
      },
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
