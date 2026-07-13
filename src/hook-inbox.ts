// hook（src/hook.ts）が状態ディレクトリの hooks.jsonl に追記した行を読み、イベントとして渡す。
// Windows の fs.watch は取りこぼすので、一定間隔でサイズを見て増えた分だけ読む。
import fs from 'node:fs';
import { z } from 'zod';
import type { Logger } from './log.js';
import { EventDedupe } from './gate.js';
import type { HookEvent } from './hook-event.js';
import { errMessage } from './errors.js';

/** 読みに行く間隔 */
export const DEFAULT_POLL_MS = 1500;
/** 起動時、この時間より新しい行は読み直して渡す（SessionStart は MCP サーバーの起動前に記録されるため） */
export const DEFAULT_REPLAY_WINDOW_MS = 30000;
/** 重複排除に覚えておく件数 */
const DEDUPE_CAPACITY = 200;
/** lastEvents で返せる上限 */
const HISTORY_CAPACITY = 50;

const HookEventSchema = z.looseObject({
  at: z.number(),
  hook_event_name: z.string().min(1),
  session_id: z.string().optional(),
  notification_type: z.string().optional(),
  message: z.string().optional(),
  source: z.string().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
  error_details: z.string().optional(),
  trigger: z.string().optional(),
  cwd: z.string().optional(),
});

export interface HookInboxOptions {
  file: string;
  logger: Logger;
  /** 1 件ずつ、記録された順に呼ぶ。投げても次へ進む */
  onEvent: (event: HookEvent) => void | Promise<void>;
  pollMs?: number | undefined;
  replayWindowMs?: number | undefined;
  now?: (() => number) | undefined;
}

export class HookInbox {
  private readonly file: string;
  private readonly logger: Logger;
  private readonly onEvent: HookInboxOptions['onEvent'];
  private readonly pollMs: number;
  private readonly replayWindowMs: number;
  private readonly now: () => number;
  private readonly seen = new EventDedupe(DEDUPE_CAPACITY);
  private readonly history: HookEvent[] = [];
  /** 読み終えた位置（バイト） */
  private offset = 0;
  /** 読んでいるファイルの識別子（回されて別のファイルになったことを検知する） */
  private ino: number | undefined;
  /** 改行で終わっていない読みかけの行 */
  private partial = '';
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(opts: HookInboxOptions) {
    this.file = opts.file;
    this.logger = opts.logger;
    this.onEvent = opts.onEvent;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.replayWindowMs = opts.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
    this.now = opts.now ?? Date.now;
  }

  /** 既にある行のうち直近のものだけ渡してから、定期的に読み始める */
  async start(): Promise<void> {
    const since = this.now() - this.replayWindowMs;
    await this.poll((event) => event.at >= since);
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 渡した順に直近 n 件（!status 用） */
  lastEvents(n: number): HookEvent[] {
    return this.history.slice(-n);
  }

  /** 増えた分を読んで渡す。accept を渡すと、それを満たす行だけ渡す（残りは読み飛ばす） */
  private async poll(accept: (event: HookEvent) => boolean = () => true): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const line of this.readNewLines()) await this.handleLine(line, accept);
    } catch (e) {
      this.logger.warn('hooks.jsonl の読み込みに失敗', e);
    } finally {
      this.polling = false;
    }
  }

  /** 前回の位置から増えた分を行に分けて返す。ファイルが無い・小さくなっていれば先頭から読み直す */
  private readNewLines(): string[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch {
      this.offset = 0;
      this.partial = '';
      this.ino = undefined;
      return [];
    }
    const size = stat.size;
    if (stat.ino !== this.ino || size < this.offset) {
      // 別のファイルになった（hooks.jsonl.1 へ回された）か、切り詰められた。最初から読む
      this.offset = 0;
      this.partial = '';
      this.ino = stat.ino;
    }
    if (size === this.offset) return [];

    const fd = fs.openSync(this.file, 'r');
    try {
      const buffer = Buffer.alloc(size - this.offset);
      const read = fs.readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += read;
      const text = this.partial + buffer.toString('utf8', 0, read);
      const lines = text.split('\n');
      this.partial = lines.pop() ?? '';
      return lines.filter((l) => l.trim() !== '');
    } finally {
      fs.closeSync(fd);
    }
  }

  private async handleLine(line: string, accept: (event: HookEvent) => boolean): Promise<void> {
    const parsed = HookEventSchema.safeParse(safeJson(line));
    if (!parsed.success) {
      this.logger.warn(`hooks.jsonl に読めない行がある: ${line.slice(0, 120)}`);
      return;
    }
    const event: HookEvent = parsed.data;
    if (!accept(event)) return;
    const key = `${event.session_id ?? ''}:${event.hook_event_name}:${event.notification_type ?? ''}:${event.at}`;
    if (this.seen.seen(key)) return;

    this.history.push(event);
    if (this.history.length > HISTORY_CAPACITY) this.history.shift();
    try {
      await this.onEvent(event);
    } catch (e) {
      this.logger.warn(`hook イベントの処理で例外 event=${event.hook_event_name}: ${errMessage(e)}`);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
