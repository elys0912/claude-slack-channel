import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USAGE_FILE, formatStatusLine, toUsageSnapshot, writeUsage } from '../src/statusline.js';

/** statusline に渡る JSON の例（公式ドキュメントの欄のうち使うものと、使わないもの） */
const INPUT = {
  session_id: 's1',
  model: { display_name: 'Opus' },
  context_window: { used_percentage: 42.4, context_window_size: 200000, total_input_tokens: 84800 },
  rate_limits: {
    five_hour: { used_percentage: 63.5, resets_at: 1761530000 },
    seven_day: { used_percentage: 41.2, resets_at: 1761900000 },
  },
};

describe('toUsageSnapshot', () => {
  it('使う欄だけを写し、記録時刻と session_tag を付ける', () => {
    expect(toUsageSnapshot(JSON.stringify(INPUT), 1000, 'tag1')).toEqual({
      at: 1000,
      session_tag: 'tag1',
      session_id: 's1',
      context: { used: 42.4, size: 200000 },
      five_hour: { used: 63.5, resets_at: 1761530000 },
      seven_day: { used: 41.2, resets_at: 1761900000 },
    });
  });

  it('rate_limits が無い（Pro / Max 以外・最初の応答の前）・コンテキストが null なら、その欄を書かない', () => {
    const input = { session_id: 's1', context_window: { used_percentage: null, context_window_size: 200000 } };
    expect(toUsageSnapshot(JSON.stringify(input), 1000)).toEqual({ at: 1000, session_id: 's1' });
  });

  it('枠の欄が欠けていれば、その枠だけ書かない', () => {
    const input = { rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 5, resets_at: 99 } } };
    expect(toUsageSnapshot(JSON.stringify(input), 1000)).toEqual({ at: 1000, seven_day: { used: 5, resets_at: 99 } });
  });

  it('JSON でなければ undefined', () => {
    expect(toUsageSnapshot('not json')).toBeUndefined();
    expect(toUsageSnapshot('null')).toBeUndefined();
  });
});

describe('formatStatusLine', () => {
  it('分かる欄だけを丸めて並べる', () => {
    expect(formatStatusLine(toUsageSnapshot(JSON.stringify(INPUT), 1000)!)).toBe('ctx 42% · 5h 64% · 7d 41%');
    expect(formatStatusLine({ at: 1000 })).toBe('');
  });
});

describe('writeUsage', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('書いて、一時ファイルを残さない', () => {
    expect(writeUsage(dir, { at: 1000, context: { used: 10 } })).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, USAGE_FILE), 'utf8'))).toEqual({ at: 1000, context: { used: 10 } });
    expect(fs.readdirSync(dir)).toEqual([USAGE_FILE]);
  });

  it('記録時刻だけが違うなら書かない。中身が変われば書く', () => {
    writeUsage(dir, { at: 1000, context: { used: 10 } });
    expect(writeUsage(dir, { at: 2000, context: { used: 10 } })).toBe(false);
    expect(writeUsage(dir, { at: 3000, context: { used: 11 } })).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, USAGE_FILE), 'utf8')).at).toBe(3000);
  });
});
