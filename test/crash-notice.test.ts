import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CRASH_FILE, takeCrashNotice } from '../src/crash-notice.js';

describe('takeCrashNotice', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-notice-test-'));
    file = path.join(dir, CRASH_FILE);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
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

  it('無ければ undefined。壊れていれば undefined にして消す', () => {
    expect(takeCrashNotice(file)).toBeUndefined();
    fs.writeFileSync(file, '{ broken');
    expect(takeCrashNotice(file)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ at: 1000 }));
    expect(takeCrashNotice(file)).toBeUndefined();
  });
});
