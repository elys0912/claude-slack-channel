import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookInbox, PARTIAL_MAX, READ_CHUNK_MAX } from '../src/hook-inbox.js';
import type { HookEvent } from '../src/hook-event.js';
import { Logger } from '../src/log.js';
import { useTempDir } from './helpers/temp-dir.js';

/** テストの HookInbox の読みに行く間隔。poll() はこの分だけ偽のタイマーを進め、1 回分読ませる */
const POLL_MS = 10;

describe('HookInbox', () => {
  const tempDir = useTempDir('hook-inbox-');
  let file: string;
  let events: HookEvent[];
  let now: number;
  /** inbox() で作ったもの。テストが失敗してもタイマーを残さないよう、afterEach で止める */
  let boxes: HookInbox[];

  const line = (event: Partial<HookEvent> & { hook_event_name: string }): string =>
    JSON.stringify({ at: now, session_id: 's1', ...event }) + '\n';
  const names = (list: HookEvent[] = events): string[] => list.map((e) => e.hook_event_name);
  const poll = (): Promise<unknown> => vi.advanceTimersByTimeAsync(POLL_MS);

  function inbox(opts: { onEvent?: (e: HookEvent) => void | Promise<void>; sessionTag?: string; logger?: Logger } = {}): HookInbox {
    const box = new HookInbox({
      file,
      logger: opts.logger ?? new Logger({ stderr: false }),
      onEvent: opts.onEvent ?? ((e) => void events.push(e)),
      sessionTag: opts.sessionTag,
      pollMs: POLL_MS,
      replayWindowMs: 1000,
      now: () => now,
    });
    boxes.push(box);
    return box;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    file = path.join(tempDir(), 'hooks.jsonl');
    events = [];
    now = 100000;
    boxes = [];
  });

  afterEach(() => {
    for (const box of boxes) box.stop();
    vi.useRealTimers();
  });

  it('起動時は再生窓の中の行だけ渡し、その後に増えた行を順に渡す', async () => {
    fs.writeFileSync(file, line({ hook_event_name: 'Old', at: now - 5000 }) + line({ hook_event_name: 'SessionStart', at: now - 500 }));
    const box = inbox();
    await box.start();
    expect(names()).toEqual(['SessionStart']);

    fs.appendFileSync(file, line({ hook_event_name: 'Stop', at: now + 1 }) + line({ hook_event_name: 'PostCompact', at: now + 2 }));
    await poll();
    expect(names()).toEqual(['SessionStart', 'Stop', 'PostCompact']);
    expect(names(box.lastEvents(2))).toEqual(['Stop', 'PostCompact']);
  });

  it('起動時は、読み直す範囲の中でも最後のセッションの開始より前（前のセッションの開始・終了）は渡さない', async () => {
    fs.writeFileSync(
      file,
      line({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'old', at: now - 900 }) +
        line({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit', session_id: 'old', at: now - 600 }) +
        line({ hook_event_name: 'SessionStart', source: 'resume', session_id: 'new', at: now - 300 }) +
        line({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'new', at: now - 200 }) +
        line({ hook_event_name: 'Stop', session_id: 'new', at: now - 100 })
    );
    const box = inbox();
    await box.start();
    expect(events.map((e) => `${e.hook_event_name}:${e.session_id}`)).toEqual(['SessionStart:new', 'SessionStart:new', 'Stop:new']);
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
    await poll();
    expect(names()).toEqual(['Stop']);
    expect(names(box.lastEvents(5))).toEqual(['Stop']);
  });

  it('sessionTag を渡さなければ、タグに関係なく全部渡す', async () => {
    const box = inbox();
    await box.start();
    fs.writeFileSync(file, line({ hook_event_name: 'Stop', session_tag: 'A', at: now + 1 }) + line({ hook_event_name: 'PostCompact', at: now + 2 }));
    await poll();
    expect(names()).toEqual(['Stop', 'PostCompact']);
  });

  it('ファイルが無くても動き、後からできれば読む。読みかけの行は次の回で完成させる', async () => {
    const box = inbox();
    await box.start();
    expect(events).toEqual([]);

    const full = line({ hook_event_name: 'Stop', at: now });
    fs.writeFileSync(file, full.slice(0, 10));
    await poll();
    expect(events).toEqual([]);
    fs.appendFileSync(file, full.slice(10));
    await poll();
    expect(names()).toEqual(['Stop']);
  });

  it('回されて別のファイルになったら先頭から読み直し、同じ行は二度渡さない', async () => {
    fs.writeFileSync(file, line({ hook_event_name: 'A', at: now }) + line({ hook_event_name: 'B', at: now + 1 }));
    const box = inbox();
    await box.start();
    expect(names()).toEqual(['A', 'B']);

    // 回されて（hooks.jsonl.1 へ移り）、新しいファイルには B（重複）と C だけ。古いものと同じ大きさでも気づく
    fs.renameSync(file, `${file}.1`);
    fs.writeFileSync(file, line({ hook_event_name: 'B', at: now + 1 }) + line({ hook_event_name: 'C', at: now + 2 }));
    await poll();
    expect(names()).toEqual(['A', 'B', 'C']);
  });

  it('回す直前に旧ファイルへ書かれた未読の行も、hooks.jsonl.1 から読み切ってから新しいファイルに移る', async () => {
    fs.writeFileSync(file, line({ hook_event_name: 'A', at: now }));
    const box = inbox();
    await box.start();
    expect(names()).toEqual(['A']);

    // 読まれる前に B が追記され、そのまま回された
    fs.appendFileSync(file, line({ hook_event_name: 'B', at: now + 1 }));
    fs.renameSync(file, `${file}.1`);
    fs.writeFileSync(file, line({ hook_event_name: 'C', at: now + 2 }));
    await poll();
    expect(names()).toEqual(['A', 'B', 'C']);
  });

  it('未読が上限を超えていれば古い分を読み飛ばし、末尾の行だけ読む', async () => {
    const filler = JSON.stringify({ at: now, hook_event_name: 'Filler', message: 'x'.repeat(READ_CHUNK_MAX) }) + '\n';
    fs.writeFileSync(file, line({ hook_event_name: 'Old', at: now }) + filler + line({ hook_event_name: 'Tail', at: now + 1 }));
    const box = inbox();
    await box.start();
    expect(names()).toEqual(['Tail']);

    fs.appendFileSync(file, line({ hook_event_name: 'Next', at: now + 2 }));
    await poll();
    expect(names()).toEqual(['Tail', 'Next']);
  });

  it('改行の無い長い行は溜め続けず、次の改行まで捨ててから読み続ける', async () => {
    const logger = new Logger({ stderr: false });
    const warn = vi.spyOn(logger, 'warn');
    const box = inbox({ logger });
    await box.start();
    fs.writeFileSync(file, 'y'.repeat(PARTIAL_MAX + 1));
    await poll();
    fs.appendFileSync(file, 'yyy' + line({ hook_event_name: 'Lost', at: now }).slice(0, 5) + '\n' + line({ hook_event_name: 'C', at: now + 1 }));
    await poll();
    expect(names()).toEqual(['C']);
    // 長い行は 1 回だけ知らせ、捨てた残り（yyy...）を読めない行として扱わない
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.filter((m) => m.includes('改行の無い長い行'))).toHaveLength(1);
    expect(messages.filter((m) => m.includes('読めない行'))).toEqual([]);
  });

  it('チャンクの境目で割れた日本語も、次の回でつないで読む', async () => {
    const box = inbox();
    await box.start();
    const bytes = Buffer.from(line({ hook_event_name: 'Notification', message: '入力待ち', at: now }));
    const cut = bytes.indexOf(Buffer.from('入')) + 1; // 「入」の 3 バイトの途中
    fs.writeFileSync(file, bytes.subarray(0, cut));
    await poll();
    fs.appendFileSync(file, bytes.subarray(cut));
    await poll();
    expect(events.map((e) => e.message)).toEqual(['入力待ち']);
  });

  it('読めない行（JSON でない・欄が足りない）は飛ばし、次の行を渡す', async () => {
    const box = inbox();
    await box.start();
    fs.writeFileSync(file, 'not json\n' + '{"at":1}\n' + line({ hook_event_name: 'Good', at: now }));
    await poll();
    expect(names()).toEqual(['Good']);
  });

  it('onEvent が投げても次の行へ進む', async () => {
    const seen: string[] = [];
    const box = inbox({
      onEvent: (e) => {
        seen.push(e.hook_event_name);
        if (e.hook_event_name === 'Bad') throw new Error('boom');
      },
    });
    await box.start();
    fs.writeFileSync(file, line({ hook_event_name: 'Bad', at: now }) + line({ hook_event_name: 'Good', at: now + 1 }));
    await poll();
    expect(seen).toEqual(['Bad', 'Good']);
  });

  it('stop の後に start しても、読まずにタイマーも作らない', async () => {
    const box = inbox();
    box.stop();
    fs.writeFileSync(file, line({ hook_event_name: 'A', at: now }));
    await box.start();
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('最初の読み込み（onEvent）の途中で stop されたら、その後は読まずにタイマーも作らない', async () => {
    fs.writeFileSync(file, line({ hook_event_name: 'A', at: now }));
    const box: HookInbox = inbox({
      onEvent: (e) => {
        events.push(e);
        box.stop();
      },
    });
    await box.start();
    expect(names()).toEqual(['A']);
    fs.appendFileSync(file, line({ hook_event_name: 'B', at: now + 1 }));
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(names()).toEqual(['A']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop の後は読まない', async () => {
    const box = inbox();
    await box.start();
    box.stop();
    fs.writeFileSync(file, line({ hook_event_name: 'Stop', at: now }));
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(events).toEqual([]);
  });
});
