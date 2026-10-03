// hook（src/hook.ts）が状態ディレクトリの hooks.jsonl に追記した行を読み、イベントとして渡す。
// Windows の fs.watch は取りこぼすので、一定間隔でサイズを見て増えた分だけ読む。
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
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
/** 1 回に読む量の上限。溜まった未読がこれを超えたら、古い分は読み飛ばして末尾のこれだけ読む */
export const READ_CHUNK_MAX = 1024 * 1024;
/** 改行の無い読みかけの行をこれ以上溜めない（超えたら、次の改行までまとめて捨てる） */
export const PARTIAL_MAX = 64 * 1024;
/** hook.ts が回した旧ファイルの名前（hooks.jsonl → hooks.jsonl.1） */
const ROTATED_SUFFIX = '.1';

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
  session_tag: z.string().optional(),
});

export interface HookInboxOptions {
  file: string;
  logger: Logger;
  /** 1 件ずつ、記録された順に呼ぶ。投げても次へ進む */
  onEvent: (event: HookEvent) => void | Promise<void>;
  /** 指定すると、session_tag がこれと同じ行だけ扱う（同じ状態ディレクトリを使う別のセッションの hook を混ぜない） */
  sessionTag?: string | undefined;
  pollMs?: number | undefined;
  replayWindowMs?: number | undefined;
  now?: (() => number) | undefined;
}

export class HookInbox {
  private readonly file: string;
  private readonly logger: Logger;
  private readonly onEvent: HookInboxOptions['onEvent'];
  private readonly sessionTag: string | undefined;
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
  /** 読みかけの行が長すぎて捨てたので、次の改行までを読み捨てる */
  private skipToNewline = false;
  /** チャンクの境目で割れた UTF-8 の文字を次の回につなぐ */
  private decoder = new StringDecoder('utf8');
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  /** stop 済み。以後 start しても何も始めない */
  private stopped = false;

  constructor(opts: HookInboxOptions) {
    this.file = opts.file;
    this.logger = opts.logger;
    this.onEvent = opts.onEvent;
    this.sessionTag = opts.sessionTag;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.replayWindowMs = opts.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
    this.now = opts.now ?? Date.now;
  }

  /** 既にある行のうち直近のものだけ渡してから、定期的に読み始める。stop の後（最初の読み込みの途中で stop された場合も）は何もしない */
  async start(): Promise<void> {
    if (this.stopped) return;
    const since = this.now() - this.replayWindowMs;
    await this.poll((event) => event.at >= since);
    if (this.stopped) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
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

  /**
   * 前回の位置から増えた分を行に分けて返す。ファイルが無い・小さくなっていれば先頭から読み直す。
   * 回されて別のファイルになったときは、旧ファイル（hooks.jsonl.1）の読み残しを読み切ってから新しいファイルに移る
   */
  private readNewLines(): string[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch {
      this.resetPosition(undefined);
      return [];
    }
    const lines: string[] = [];
    if (stat.ino !== this.ino) {
      if (this.ino !== undefined) lines.push(...this.drainRotated(this.ino));
      this.resetPosition(stat.ino);
    } else if (stat.size < this.offset) {
      // 切り詰められた。最初から読む
      this.resetPosition(stat.ino);
    }
    lines.push(...this.readRange(this.file, stat.size));
    return lines;
  }

  /** 読む位置と読みかけを捨てて、ino のファイルの先頭から読むことにする */
  private resetPosition(ino: number | undefined): void {
    this.offset = 0;
    this.partial = '';
    this.skipToNewline = false;
    this.decoder = new StringDecoder('utf8');
    this.ino = ino;
  }

  /** 回された旧ファイルが読んでいたファイル（oldIno）なら、読み残しを読み切る。最後の改行の無い行は捨てる */
  private drainRotated(oldIno: number): string[] {
    const rotated = this.file + ROTATED_SUFFIX;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(rotated);
    } catch {
      return [];
    }
    if (stat.ino !== oldIno || stat.size <= this.offset) return [];
    try {
      return this.readRange(rotated, stat.size);
    } catch (e) {
      this.logger.warn('回された hooks.jsonl.1 の読み残しを読めなかった', e);
      return [];
    }
  }

  /** file の offset から size までを読み、改行で区切った行を返す。未読が READ_CHUNK_MAX を超えていれば古い分を読み飛ばす */
  private readRange(file: string, size: number): string[] {
    if (size <= this.offset) return [];
    if (size - this.offset > READ_CHUNK_MAX) {
      const skipped = size - READ_CHUNK_MAX - this.offset;
      this.logger.warn(`hooks.jsonl の未読が大きすぎるので、古い ${skipped} バイトを読み飛ばす`);
      this.offset = size - READ_CHUNK_MAX;
      // 途中から読むので、最初の改行までは行の途中。読みかけも捨てる
      this.partial = '';
      this.skipToNewline = true;
      this.decoder = new StringDecoder('utf8');
    }

    const fd = fs.openSync(file, 'r');
    let text: string;
    try {
      const buffer = Buffer.alloc(size - this.offset);
      const read = fs.readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += read;
      text = this.decoder.write(buffer.subarray(0, read));
    } finally {
      fs.closeSync(fd);
    }
    return this.splitLines(text);
  }

  /** 読みかけとつないで行に分ける。読みかけが PARTIAL_MAX を超えたら捨て、次の改行まで読み捨てる */
  private splitLines(text: string): string[] {
    if (this.skipToNewline) {
      const newline = text.indexOf('\n');
      if (newline < 0) return [];
      text = text.slice(newline + 1);
      this.skipToNewline = false;
    }
    const lines = (this.partial + text).split('\n');
    this.partial = lines.pop() ?? '';
    if (this.partial.length > PARTIAL_MAX) {
      this.logger.warn(`hooks.jsonl に改行の無い長い行がある（${this.partial.length} 文字）。次の改行まで読み捨てる`);
      this.partial = '';
      this.skipToNewline = true;
    }
    return lines.filter((l) => l.trim() !== '');
  }

  private async handleLine(line: string, accept: (event: HookEvent) => boolean): Promise<void> {
    const parsed = HookEventSchema.safeParse(safeJson(line));
    if (!parsed.success) {
      this.logger.warn(`hooks.jsonl に読めない行がある: ${line.slice(0, 120)}`);
      return;
    }
    const event: HookEvent = parsed.data;
    if (this.sessionTag !== undefined && event.session_tag !== this.sessionTag) return;
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
