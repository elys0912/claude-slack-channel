// 使用量とコンテキストの見張り。statusline（statusline.ts）が書く usage.json を定期的に読み、
// 使用量（5 時間枠・7 日枠）とコンテキストの使用率がしきい値を越えたら知らせる。使用量の上限に当たった後、
// 枠のリセット時刻を過ぎたら「上限が戻った」を知らせる（Claude に作業の再開は送らない。続けるかは人が決める）。
import type { Logger } from './log.js';
import { formatTime } from './text.js';
import { isObject, readJsonFile } from './state-file.js';
import type { UsageSnapshot, UsageWindow } from './statusline.js';

export const DEFAULT_USAGE_WARN_PCT: readonly number[] = [80, 95];
export const DEFAULT_CONTEXT_WARN_PCT: readonly number[] = [70, 90];
export const DEFAULT_USAGE_POLL_MS = 30_000;

/** 枠の名前（usage.json の欄）と表示 */
const WINDOWS = [
  { key: 'five_hour', label: '5 時間枠' },
  { key: 'seven_day', label: '7 日枠' },
] as const;
/** usage.json の resets_at は秒（Unix 時刻）なので、ミリ秒の時刻と比べるときに掛ける */
const MS_PER_SECOND = 1000;

/** リセット時刻を過ぎていない枠と、その名前・表示 */
interface ActiveWindow {
  key: string;
  label: string;
  window: UsageWindow;
}

/** 枠のリセット時刻（ミリ秒の Unix 時刻） */
function resetsAtMs(window: UsageWindow): number {
  return window.resets_at * MS_PER_SECOND;
}

/** `80,95` を昇順の割合の並びにする。空なら空の並び（知らせない）。1〜100 の整数でなければ投げる */
export function parsePercents(text: string): number[] {
  const t = text.trim();
  if (t === '') return [];
  const values = t.split(',').map((part) => {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error(`割合は 1〜100 の整数をカンマ区切りで指定する: ${t}`);
    return n;
  });
  return [...new Set(values)].sort((a, b) => a - b);
}

/** 記録時刻（at）だけを確かめる。ほかの欄は statusline.ts が書いた形のまま信じる */
function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  return isObject(value) && typeof value.at === 'number';
}

/** usage.json を読む。無い・壊れていれば undefined */
export function readUsage(file: string): UsageSnapshot | undefined {
  return readJsonFile(file, isUsageSnapshot);
}

/** used が越えたしきい値のうち最大のもの。越えていなければ undefined */
function reachedLevel(used: number, levels: readonly number[]): number | undefined {
  let reached: number | undefined;
  for (const level of levels) if (used >= level) reached = level;
  return reached;
}

/** level が最上位のしきい値か。しきい値が 1 つだけなら、強い文面にはしないので false */
function isTopLevel(level: number, levels: readonly number[]): boolean {
  return level === levels.at(-1) && levels.length > 1;
}

export interface UsageWatchOptions {
  /** usage.json のパス */
  file: string;
  /** 自分のセッションの session_tag。usage.json の値と違えば読まない（同じ状態ディレクトリの別セッション）。省略時は見ない */
  sessionTag?: string | undefined;
  /** 使用量のしきい値（昇順）。空なら使用量は知らせない */
  usageWarnPct: readonly number[];
  /** コンテキストのしきい値（昇順）。空ならコンテキストは知らせない */
  contextWarnPct: readonly number[];
  /** 知らせる。投げても見張りは止まらない */
  notify: (text: string) => Promise<void>;
  logger: Logger;
  pollMs?: number | undefined;
  now?: () => number;
}

export class UsageWatch {
  private readonly opts: UsageWatchOptions;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private latest: UsageSnapshot | undefined;
  /** 枠（`five_hour:<resets_at>`）ごとに知らせた最大のしきい値 */
  private readonly usageNotified = new Map<string, number>();
  /** 今の会話で知らせたコンテキストの最大のしきい値 */
  private contextNotified: number | undefined;
  private contextSessionId: string | undefined;
  /** 使用量の上限に当たった後、戻ったと知らせる時刻（epoch ms）。上限に当たっていなければ undefined */
  private limitedUntil: number | undefined;
  /** 上限に当たった（リセット時刻は分からなくてもよい） */
  private limited = false;

  constructor(opts: UsageWatchOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.opts.pollMs ?? DEFAULT_USAGE_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** usage.json を読み、しきい値と上限からの戻りを調べて知らせる */
  async check(): Promise<void> {
    const snapshot = readUsage(this.opts.file);
    if (snapshot && (this.opts.sessionTag === undefined || snapshot.session_tag === this.opts.sessionTag)) {
      this.latest = snapshot;
    }
    const messages = [...this.takeUsageMessages(), ...this.takeContextMessages(), ...this.takeRecoveredMessages()];
    for (const text of messages) {
      try {
        await this.opts.notify(text);
      } catch (e) {
        this.opts.logger.warn('使用量の知らせを送れなかった', e);
      }
    }
  }

  /** 使用量の上限に当たった（StopFailure の rate_limit）。いちばん使っている枠のリセット時刻を過ぎたら、戻ったと知らせる */
  limitHit(): void {
    this.limited = true;
    const windows = this.activeWindows();
    const top = windows.sort((a, b) => b.window.used - a.window.used)[0];
    this.limitedUntil = top ? resetsAtMs(top.window) : undefined;
  }

  /** 応答が終わった（上限は戻っている）。戻ったとは知らせずに上限の印を消す */
  limitCleared(): void {
    this.limited = false;
    this.limitedUntil = undefined;
  }

  /** 新しい会話・圧縮の後。コンテキストの知らせを数え直す */
  contextReset(): void {
    this.contextNotified = undefined;
  }

  /** 使用量がいちばん低いしきい値以上の枠があるか（キャッシュのつなぎ止めを控える目安） */
  isHigh(): boolean {
    const first = this.opts.usageWarnPct[0];
    return first !== undefined && this.activeWindows().some(({ window }) => window.used >= first);
  }

  /** `!status` に出す行。記録が無ければ undefined */
  statusLine(): string | undefined {
    const s = this.latest;
    if (!s) return undefined;
    const parts: string[] = [];
    for (const { label, window } of this.activeWindows()) {
      parts.push(`${label} ${Math.round(window.used)}%（リセット ${formatTime(new Date(resetsAtMs(window)))}）`);
    }
    if (s.context) parts.push(`コンテキスト ${Math.round(s.context.used)}%`);
    if (parts.length === 0) return undefined;
    return `使用量: ${parts.join('・')}（${formatTime(new Date(s.at))} 時点）`;
  }

  /** リセット時刻を過ぎていない枠 */
  private activeWindows(): ActiveWindow[] {
    const s = this.latest;
    if (!s) return [];
    const nowSec = this.now() / MS_PER_SECOND;
    const result: ActiveWindow[] = [];
    for (const { key, label } of WINDOWS) {
      const window = s[key];
      if (window && window.resets_at > nowSec) result.push({ key, label, window });
    }
    return result;
  }

  /** 新しく越えたしきい値の知らせ。1 回だけ知らせるため、返した分は知らせた印（usageNotified）を進める */
  private takeUsageMessages(): string[] {
    const levels = this.opts.usageWarnPct;
    const messages: string[] = [];
    for (const { key, label, window } of this.activeWindows()) {
      const level = reachedLevel(window.used, levels);
      const id = `${key}:${window.resets_at}`;
      if (level === undefined || level <= (this.usageNotified.get(id) ?? 0)) continue;
      this.usageNotified.set(id, level);
      const resets = formatTime(new Date(resetsAtMs(window)));
      const used = Math.round(window.used);
      messages.push(
        isTopLevel(level, levels)
          ? `🛑 使用量（${label}）が ${used}%。重い作業は区切りのよいところで止める（リセット ${resets}）`
          : `⚠️ 使用量（${label}）が ${used}%（リセット ${resets}）`
      );
    }
    return messages;
  }

  /** 新しく越えたコンテキストのしきい値の知らせ。返した分は知らせた印（contextNotified）を進める */
  private takeContextMessages(): string[] {
    const s = this.latest;
    if (!s?.context) return [];
    // 会話が替わったら数え直す（SessionStart の知らせより先に usage.json が替わることがある）
    if (s.session_id !== undefined && s.session_id !== this.contextSessionId) {
      this.contextSessionId = s.session_id;
      this.contextNotified = undefined;
    }
    const levels = this.opts.contextWarnPct;
    const level = reachedLevel(s.context.used, levels);
    if (level === undefined || level <= (this.contextNotified ?? 0)) return [];
    this.contextNotified = level;
    const used = Math.round(s.context.used);
    return [
      isTopLevel(level, levels)
        ? `⚠️ コンテキストが ${used}%。!compact（要約して縮める）か !clear（新しい会話）を勧める`
        : `ℹ️ コンテキストが ${used}%。区切りのよいところで !compact を検討する`,
    ];
  }

  /** 上限のリセット時刻を過ぎていれば、戻った知らせ。返したら上限の印を消す（limitCleared） */
  private takeRecoveredMessages(): string[] {
    if (!this.limited || this.limitedUntil === undefined || this.now() < this.limitedUntil) return [];
    const at = formatTime(new Date(this.limitedUntil));
    this.limitCleared();
    return [`✅ 使用量の上限が戻った（${at} にリセット）。続けるなら指示を送る`];
  }
}
