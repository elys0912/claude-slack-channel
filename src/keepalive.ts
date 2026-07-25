// キャッシュのつなぎ止め（keepalive）。
// Claude Code のプロンプトキャッシュは 1 時間で切れ、読むたびに延びる。切れたあとに話しかけると会話全体を書き直す
// （通常の 2 倍。読むだけなら 0.1 倍）ので、最後に Claude が動いてから少し前に短いメッセージを 1 回送ってつなぎ止める。
// 書き直し 1 回はつなぎ止め約 20 回ぶんなので、回数に上限を付け、送らない時間帯も設ける。
import type { Logger } from './log.js';
import { formatTime } from './text.js';

export interface QuietHours {
  /** 0 時からの分（この時刻から送らない） */
  start: number;
  /** 0 時からの分（この時刻から送ってよい）。start より小さければ日付をまたぐ */
  end: number;
}

export const DEFAULT_KEEPALIVE_AFTER_MIN = 55;
export const DEFAULT_KEEPALIVE_MAX = 6;
export const DEFAULT_KEEPALIVE_QUIET: QuietHours = { start: 60, end: 7 * 60 };

const QUIET_RE = /^([01]?\d|2[0-3]):([0-5]\d)-([01]?\d|2[0-3]):([0-5]\d)$/;

/** `HH:MM-HH:MM` を読む。空・off なら undefined（時間帯なし）。形が違えば投げる */
export function parseQuietHours(text: string): QuietHours | undefined {
  const t = text.trim();
  if (t === '' || t.toLowerCase() === 'off') return undefined;
  const m = QUIET_RE.exec(t);
  if (!m) throw new Error(`時間帯の形が不正（HH:MM-HH:MM）: ${t}`);
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start === end) throw new Error(`時間帯の始まりと終わりが同じ: ${t}`);
  return { start, end };
}

/** その時刻（ローカル時刻）が送らない時間帯に入るか */
export function inQuietHours(quiet: QuietHours | undefined, at: Date): boolean {
  if (!quiet) return false;
  const m = at.getHours() * 60 + at.getMinutes();
  return quiet.start < quiet.end ? m >= quiet.start && m < quiet.end : m >= quiet.start || m < quiet.end;
}

export interface KeepaliveOptions {
  enabled: boolean;
  afterMs: number;
  max: number;
  quiet: QuietHours | undefined;
  /** つなぎ止めのメッセージを Claude に送る */
  send: () => Promise<void>;
  /** 作業中・実行許可の回答待ちなど、送ってはいけない状態か */
  isBusy: () => boolean;
  /** 使用量の上限に当たっているか */
  isLimited: () => boolean;
  logger: Logger;
  now?: () => number;
}

export interface KeepaliveStatus {
  enabled: boolean;
  /** 次に送る時刻。決まっていなければ undefined */
  nextAt: Date | undefined;
  sent: number;
  max: number;
}

/** `!status` に出すキャッシュのつなぎ止めの行 */
export function keepaliveStatusLine(k: KeepaliveStatus): string {
  if (!k.enabled) return 'キャッシュのつなぎ止め: 無効（!keepalive on で有効）';
  const next = k.nextAt ? `次は ${formatTime(k.nextAt)}` : '予定なし';
  return `キャッシュのつなぎ止め: 有効（${next}、送った回数 ${k.sent}/${k.max}）`;
}

export class Keepalive {
  private readonly opts: KeepaliveOptions;
  private readonly now: () => number;
  private enabled: boolean;
  private lastRequestAt: number | undefined;
  private sent = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextAt: number | undefined;

  constructor(opts: KeepaliveOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.enabled = opts.enabled;
  }

  /** Claude の応答が終わった（hook の Stop / StopFailure）。そこから afterMs 後に送る予定を立て直す */
  requestEnded(at: number): void {
    this.lastRequestAt = at;
    this.schedule();
  }

  /** 本物のメッセージを中継した・新しい会話になった。送った回数を 0 に戻す */
  resetCount(): void {
    this.sent = 0;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.schedule();
  }

  status(): KeepaliveStatus {
    return {
      enabled: this.enabled,
      nextAt: this.nextAt === undefined ? undefined : new Date(this.nextAt),
      sent: this.sent,
      max: this.opts.max,
    };
  }

  stop(): void {
    this.clear();
  }

  private clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextAt = undefined;
  }

  private schedule(): void {
    this.clear();
    if (!this.enabled || this.lastRequestAt === undefined || this.sent >= this.opts.max) return;
    const at = this.lastRequestAt + this.opts.afterMs;
    this.nextAt = at;
    this.timer = setTimeout(() => void this.fire(), Math.max(0, at - this.now()));
    this.timer.unref?.();
  }

  /** 送る前の確認。送らない理由があれば返す */
  private skipReason(): string | undefined {
    if (!this.enabled) return '無効';
    if (this.sent >= this.opts.max) return `上限（${this.opts.max} 回）`;
    if (this.opts.isBusy()) return '作業中か回答待ち';
    if (inQuietHours(this.opts.quiet, new Date(this.now()))) return '送らない時間帯';
    if (this.opts.isLimited()) return '使用量の上限';
    return undefined;
  }

  private async fire(): Promise<void> {
    this.timer = undefined;
    this.nextAt = undefined;
    const reason = this.skipReason();
    if (reason) {
      this.opts.logger.info(`keepalive を送らない（${reason}）。キャッシュは切れるに任せる`);
      return;
    }
    this.sent += 1;
    try {
      await this.opts.send();
      this.opts.logger.info(`keepalive を送った（${this.sent}/${this.opts.max}）`);
    } catch (e) {
      this.opts.logger.warn('keepalive の送信に失敗', e);
    }
  }
}
