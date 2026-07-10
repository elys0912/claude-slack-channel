// Claude の無応答を検知して Slack に知らせる見張り。
// ターミナル側の選択画面（Slack に中継されない）・使用量の上限・セッションの停止などで Claude が黙ると、
// Slack からは「👀 は付いたのに何も返ってこない」ようにしか見えないため、一定時間で警告を出す。
import type { Logger } from './log.js';

/** 既定の待ち時間（分） */
export const DEFAULT_REPLY_TIMEOUT_MIN = 5;

export interface WatchdogTarget {
  channel: string;
  threadTs: string;
}

export interface WatchdogOptions {
  /** 待ち時間（ミリ秒）。0 以下なら見張らない */
  timeoutMs: number;
  logger: Logger;
  /** 無応答のまま待ち時間を過ぎたときに呼ぶ。投げても見張りは止まらない */
  notify: (target: WatchdogTarget, minutes: number) => Promise<void>;
}

/**
 * 最後に Claude へ渡したメッセージから timeoutMs の間、Claude の動き（reply / react / edit_message /
 * permission_request）が 1 つも無ければ notify を 1 回呼ぶ。見張るのは常に最後の 1 件だけ
 * （セッションは 1 つなので、新しいメッセージが届いたら待ち時間を最初から数え直す）。
 */
export class ResponseWatchdog {
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly notify: WatchdogOptions['notify'];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: WatchdogOptions) {
    this.timeoutMs = opts.timeoutMs;
    this.logger = opts.logger;
    this.notify = opts.notify;
  }

  /** Claude にメッセージを渡した。待ち時間を最初から数え直す */
  delivered(target: WatchdogTarget): void {
    if (this.timeoutMs <= 0) return;
    this.clear();
    const timer = setTimeout(() => {
      this.timer = undefined;
      void this.fire(target);
    }, this.timeoutMs);
    timer.unref?.();
    this.timer = timer;
  }

  /** Claude が何か返した。見張りを解く */
  activity(): void {
    this.clear();
  }

  /** 終了時用。見張りを解く */
  stop(): void {
    this.clear();
  }

  private clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async fire(target: WatchdogTarget): Promise<void> {
    const minutes = Math.round(this.timeoutMs / 60000);
    this.logger.warn(`Claude から ${minutes} 分応答が無い channel=${target.channel} thread=${target.threadTs}`);
    try {
      await this.notify(target, minutes);
    } catch (e) {
      this.logger.warn('無応答の通知に失敗', e);
    }
  }
}

/** 無応答の通知文 */
export function buildNoResponseText(minutes: number): string {
  return (
    `⚠️ Claude から ${minutes} 分応答が無い。作業が長引いているだけかもしれないが、次のどれかで止まっている可能性がある。\n` +
    '• ターミナル側の選択画面や確認（Slack には中継されない）\n' +
    '• 使用量の上限\n' +
    '• セッションの停止\n' +
    '手元のターミナルを確認すること。'
  );
}

/**
 * 環境変数 SLACK_CHANNEL_REPLY_TIMEOUT_MIN（分）から待ち時間（ミリ秒）を決める。
 * 未設定なら既定値、0 なら無効（0 を返す）。数でない・負の値は既定値に戻す。
 */
export function replyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SLACK_CHANNEL_REPLY_TIMEOUT_MIN;
  if (raw === undefined || raw.trim() === '') return DEFAULT_REPLY_TIMEOUT_MIN * 60000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_REPLY_TIMEOUT_MIN * 60000;
  return n * 60000;
}
