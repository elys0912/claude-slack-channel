import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_LOG_MAX_BYTES, appendHookLine, toHookEvent } from '../src/hook.js';
import { HOOK_LOG_FILE } from '../src/hook-event.js';

describe('toHookEvent', () => {
  it('使う欄だけを写し、記録時刻を付ける', () => {
    const event = toHookEvent(
      JSON.stringify({
        hook_event_name: 'Notification',
        session_id: 's1',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission',
        transcript_path: '/x/y.jsonl',
        cwd: 'C:\\dev',
        extra: { nested: true },
      }),
      1000
    );
    expect(event).toEqual({
      at: 1000,
      hook_event_name: 'Notification',
      session_id: 's1',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission',
      cwd: 'C:\\dev',
    });
  });

  it('JSON でない・hook_event_name が無い・文字列でない欄は扱わない', () => {
    expect(toHookEvent('{"hook_event_name":"Stop"}', 1, 'tag-1')).toEqual({ at: 1, hook_event_name: 'Stop', session_tag: 'tag-1' });
    // stdin に session_tag があっても写さない（記録するのは start.ps1 が渡した環境変数の値だけ）
    expect(toHookEvent('{"hook_event_name":"Stop","session_tag":"forged"}', 1)).toEqual({ at: 1, hook_event_name: 'Stop' });
    expect(toHookEvent('not json')).toBeUndefined();
    expect(toHookEvent('{"session_id":"s1"}')).toBeUndefined();
    expect(toHookEvent('[1,2]')).toBeUndefined();
    expect(toHookEvent('{"hook_event_name":"Stop","error":42}', 1)).toEqual({ at: 1, hook_event_name: 'Stop' });
  });

  it('長い自由文は 500 文字で切る', () => {
    const event = toHookEvent(JSON.stringify({ hook_event_name: 'StopFailure', error_details: 'x'.repeat(2000) }));
    expect(event?.error_details).toHaveLength(500);
  });
});

describe('appendHookLine', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ディレクトリが無くても作り、1 行ずつ JSON で追記する', () => {
    const sub = path.join(dir, 'state');
    appendHookLine(sub, '{"hook_event_name":"SessionStart","source":"startup"}', 1);
    appendHookLine(sub, '{"hook_event_name":"Stop"}', 2);
    const lines = fs.readFileSync(path.join(sub, HOOK_LOG_FILE), 'utf8').trimEnd().split('\n');
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { at: 1, hook_event_name: 'SessionStart', source: 'startup' },
      { at: 2, hook_event_name: 'Stop' },
    ]);
  });

  it('JSON でない入力は何も書かない', () => {
    expect(appendHookLine(dir, 'garbage')).toBeUndefined();
    expect(fs.existsSync(path.join(dir, HOOK_LOG_FILE))).toBe(false);
  });

  it('上限を超えていたら .1 に回してから追記する', () => {
    const file = path.join(dir, HOOK_LOG_FILE);
    fs.writeFileSync(file, 'x'.repeat(HOOK_LOG_MAX_BYTES + 1));
    appendHookLine(dir, '{"hook_event_name":"Stop"}', 3);
    expect(fs.statSync(`${file}.1`).size).toBe(HOOK_LOG_MAX_BYTES + 1);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"at":3,"hook_event_name":"Stop"}\n');
  });
});
