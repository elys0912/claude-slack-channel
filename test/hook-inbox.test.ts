import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookInbox } from '../src/hook-inbox.js';
import type { HookEvent } from '../src/hook-event.js';
import { Logger } from '../src/log.js';

describe('HookInbox', () => {
  let dir: string;
  let file: string;
  let events: HookEvent[];
  let now: number;

  const line = (event: Partial<HookEvent> & { hook_event_name: string }): string =>
    JSON.stringify({ at: now, session_id: 's1', ...event }) + '\n';

  function inbox(opts: { onEvent?: (e: HookEvent) => void | Promise<void>; sessionTag?: string } = {}): HookInbox {
    return new HookInbox({
      file,
      logger: new Logger({ stderr: false }),
      onEvent: opts.onEvent ?? ((e) => void events.push(e)),
      sessionTag: opts.sessionTag,
      pollMs: 10,
      replayWindowMs: 1000,
      now: () => now,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-inbox-'));
    file = path.join(dir, 'hooks.jsonl');
    events = [];
    now = 100000;
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('起動時は再生窓の中の行だけ渡し、その後に増えた行を順に渡す', async () => {
    fs.writeFileSync(file, line({ hook_event_name: 'Old', at: now - 5000 }) + line({ hook_event_name: 'SessionStart', at: now - 500 }));
    const box = inbox();
    await box.start();
    expect(events.map((e) => e.hook_event_name)).toEqual(['SessionStart']);

    fs.appendFileSync(file, line({ hook_event_name: 'Stop', at: now + 1 }) + line({ hook_event_name: 'PostCompact', at: now + 2 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(events.map((e) => e.hook_event_name)).toEqual(['SessionStart', 'Stop', 'PostCompact']);
    expect(box.lastEvents(2).map((e) => e.hook_event_name)).toEqual(['Stop', 'PostCompact']);
    box.stop();
  });

  it('sessionTag を渡すと、同じ session_tag の行だけ渡し、履歴にも残さない', async () => {
    const box = inbox({ sessionTag: 'A' });
    await box.start();
    fs.writeFileSync(
      file,
      line({ hook_event_name: 'Stop', session_tag: 'A', at: now + 1 }) +
        line({ hook_event_name: 'SessionEnd', session_tag: 'B', at: now + 2 }) +
        line({ hook_event_name: 'PostCompact', at: now + 3 })
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(events.map((e) => e.hook_event_name)).toEqual(['Stop']);
    expect(box.lastEvents(5).map((e) => e.hook_event_name)).toEqual(['Stop']);
    box.stop();
  });

  it('sessionTag を渡さなければ、タグに関係なく全部渡す', async () => {
    const box = inbox();
    await box.start();
    fs.writeFileSync(file, line({ hook_event_name: 'Stop', session_tag: 'A', at: now + 1 }) + line({ hook_event_name: 'PostCompact', at: now + 2 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(events.map((e) => e.hook_event_name)).toEqual(['Stop', 'PostCompact']);
    box.stop();
  });

  it('ファイルが無くても動き、後からできれば読む。読みかけの行は次の回で完成させる', async () => {
    const box = inbox();
    await box.start();
    expect(events).toEqual([]);

    const full = line({ hook_event_name: 'Stop', at: now });
    fs.writeFileSync(file, full.slice(0, 10));
    await vi.advanceTimersByTimeAsync(10);
    expect(events).toEqual([]);
    fs.appendFileSync(file, full.slice(10));
    await vi.advanceTimersByTimeAsync(10);
    expect(events.map((e) => e.hook_event_name)).toEqual(['Stop']);
    box.stop();
  });

  it('回されて別のファイルになったら先頭から読み直し、同じ行は二度渡さない', async () => {
    fs.writeFileSync(file, line({ hook_event_name: 'A', at: now }) + line({ hook_event_name: 'B', at: now + 1 }));
    const box = inbox();
    await box.start();
    expect(events.map((e) => e.hook_event_name)).toEqual(['A', 'B']);

    // 回されて（hooks.jsonl.1 へ移り）、新しいファイルには B（重複）と C だけ。古いものと同じ大きさでも気づく
    fs.renameSync(file, `${file}.1`);
    fs.writeFileSync(file, line({ hook_event_name: 'B', at: now + 1 }) + line({ hook_event_name: 'C', at: now + 2 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(events.map((e) => e.hook_event_name)).toEqual(['A', 'B', 'C']);
    box.stop();
  });

  it('読めない行は飛ばし、onEvent が投げても次の行へ進む', async () => {
    const seen: string[] = [];
    const box = inbox({
      onEvent: (e) => {
        seen.push(e.hook_event_name);
        if (e.hook_event_name === 'Bad') throw new Error('boom');
      },
    });
    await box.start();
    fs.writeFileSync(file, 'not json\n' + '{"at":1}\n' + line({ hook_event_name: 'Bad', at: now }) + line({ hook_event_name: 'Good', at: now + 1 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual(['Bad', 'Good']);
    box.stop();
  });

  it('stop の後は読まない', async () => {
    const box = inbox();
    await box.start();
    box.stop();
    fs.writeFileSync(file, line({ hook_event_name: 'Stop', at: now }));
    await vi.advanceTimersByTimeAsync(50);
    expect(events).toEqual([]);
  });
});
