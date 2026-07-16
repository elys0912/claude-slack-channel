import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookInbox, PARTIAL_MAX, READ_CHUNK_MAX } from '../src/hook-inbox.js';
import type { HookEvent } from '../src/hook-event.js';
import { Logger } from '../src/log.js';

describe('HookInbox', () => {
  let dir: string;
  let file: string;
  let events: HookEvent[];
  let now: number;

  const line = (event: Partial<HookEvent> & { hook_event_name: string }): string =>
    JSON.stringify({ at: now, session_id: 's1', ...event }) + '\n';

  function inbox(opts: { onEvent?: (e: HookEvent) => void | Promise<void>; sessionTag?: string; logger?: Logger } = {}): HookInbox {
    return new HookInbox({
      file,
      logger: opts.logger ?? new Logger({ stderr: false }),
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

  it('回す直前に旧ファイルへ書かれた未読の行も、hooks.jsonl.1 から読み切ってから新しいファイルに移る', async () => {
    fs.writeFileSync(file, line({ hook_event_name: 'A', at: now }));
    const box = inbox();
    await box.start();
    expect(events.map((e) => e.hook_event_name)).toEqual(['A']);

    // 読まれる前に B が追記され、そのまま回された
    fs.appendFileSync(file, line({ hook_event_name: 'B', at: now + 1 }));
    fs.renameSync(file, `${file}.1`);
    fs.writeFileSync(file, line({ hook_event_name: 'C', at: now + 2 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(events.map((e) => e.hook_event_name)).toEqual(['A', 'B', 'C']);
    box.stop();
  });

  it('未読が上限を超えていれば古い分を読み飛ばし、末尾の行だけ読む', async () => {
    const filler = JSON.stringify({ at: now, hook_event_name: 'Filler', message: 'x'.repeat(READ_CHUNK_MAX) }) + '\n';
    fs.writeFileSync(file, line({ hook_event_name: 'Old', at: now }) + filler + line({ hook_event_name: 'Tail', at: now + 1 }));
    const box = inbox();
    await box.start();
    expect(events.map((e) => e.hook_event_name)).toEqual(['Tail']);

    fs.appendFileSync(file, line({ hook_event_name: 'Next', at: now + 2 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(events.map((e) => e.hook_event_name)).toEqual(['Tail', 'Next']);
    box.stop();
  });

  it('改行の無い長い行は溜め続けず、次の改行まで捨ててから読み続ける', async () => {
    const logger = new Logger({ stderr: false });
    const warn = vi.spyOn(logger, 'warn');
    const box = inbox({ logger });
    await box.start();
    fs.writeFileSync(file, 'y'.repeat(PARTIAL_MAX + 1));
    await vi.advanceTimersByTimeAsync(10);
    fs.appendFileSync(file, 'yyy' + line({ hook_event_name: 'Lost', at: now }).slice(0, 5) + '\n' + line({ hook_event_name: 'C', at: now + 1 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(events.map((e) => e.hook_event_name)).toEqual(['C']);
    // 長い行は 1 回だけ知らせ、捨てた残り（yyy...）を読めない行として扱わない
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.filter((m) => m.includes('改行の無い長い行'))).toHaveLength(1);
    expect(messages.filter((m) => m.includes('読めない行'))).toEqual([]);
    box.stop();
  });

  it('チャンクの境目で割れた日本語も、次の回でつないで読む', async () => {
    const box = inbox();
    await box.start();
    const bytes = Buffer.from(line({ hook_event_name: 'Notification', message: '入力待ち', at: now }));
    const cut = bytes.indexOf(Buffer.from('入')) + 1; // 「入」の 3 バイトの途中
    fs.writeFileSync(file, bytes.subarray(0, cut));
    await vi.advanceTimersByTimeAsync(10);
    fs.appendFileSync(file, bytes.subarray(cut));
    await vi.advanceTimersByTimeAsync(10);
    expect(events.map((e) => e.message)).toEqual(['入力待ち']);
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

  it('stop の後に start しても、最初の読み込みの途中で stop されても、タイマーを作らない', async () => {
    const stoppedFirst = inbox();
    stoppedFirst.stop();
    fs.writeFileSync(file, line({ hook_event_name: 'A', at: now }));
    await stoppedFirst.start();
    expect(events).toEqual([]);

    // 最初の読み込み（onEvent）の途中で stop される
    const box: HookInbox = inbox({
      onEvent: (e) => {
        events.push(e);
        box.stop();
      },
    });
    await box.start();
    expect(events.map((e) => e.hook_event_name)).toEqual(['A']);
    fs.appendFileSync(file, line({ hook_event_name: 'B', at: now + 1 }));
    await vi.advanceTimersByTimeAsync(50);
    expect(events.map((e) => e.hook_event_name)).toEqual(['A']);
    expect(vi.getTimerCount()).toBe(0);
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
