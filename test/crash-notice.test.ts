import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CRASH_FILE, takeCrashNotice } from '../src/crash-notice.js';
import { useTempDir } from './helpers/temp-dir.js';

describe('takeCrashNotice', () => {
  const tempDir = useTempDir('crash-notice-test-');
  let file: string;

  beforeEach(() => {
    file = path.join(tempDir(), CRASH_FILE);
  });

  it('crash.json を読んで知らせの文にし、消す（BOM 付きも読む）', () => {
    const record = { at: 1000, exit_code: 1, count: 2, max: 3, window_min: 10, resumed: true };
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify(record));

    expect(takeCrashNotice(file)).toBe(
      '♻️ Claude Code が想定外に終了した（exit code 1）ので起動し直した（10 分で 2/3 回目。同じ会話を開いた）'
    );
    expect(fs.existsSync(file)).toBe(false);
  });

  it('会話を引き継げなかったときは、新しい会話で起動したと書く', () => {
    fs.writeFileSync(file, JSON.stringify({ at: 1000, exit_code: -1, count: 1, max: 3, window_min: 10, resumed: false }));
    expect(takeCrashNotice(file)).toContain('新しい会話で起動した');
  });

  it('crash.json が無ければ undefined', () => {
    expect(takeCrashNotice(file)).toBeUndefined();
  });

  it('JSON として壊れていれば undefined にして消す', () => {
    fs.writeFileSync(file, '{ broken');
    expect(takeCrashNotice(file)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('キーが欠けた記録は undefined', () => {
    fs.writeFileSync(file, JSON.stringify({ at: 1000 }));
    expect(takeCrashNotice(file)).toBeUndefined();
  });
});
