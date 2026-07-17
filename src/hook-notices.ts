// hook のイベントを Slack に出す文言に変える純関数（I/O なし）。出さないものは undefined
import type { HookEvent } from './hook-event.js';

export interface NoticeContext {
  /** Claude に渡したメッセージへの応答をまだ受け取っていない */
  waiting: boolean;
  /** Slack に出している（回答待ちの）permission request の件数 */
  pending: number;
}

export interface HookNotice {
  text: string;
  /** 「🖥 画面を確認」ボタンを付ける（ターミナル側で止まっているとき） */
  screenButton: boolean;
}

const TERMINAL_WAITING = '🖥 ターミナル側で入力待ちになっている（Slack には中継されない）。画面を確認して選ぶこと。';

/** StopFailure の error 種別 → 表示 */
const STOP_FAILURE_TEXT: Record<string, string> = {
  rate_limit: '使用量の上限（rate limit）に達した。上限が戻るまで応答できない',
  overloaded: 'API が混雑している（overloaded）。しばらくして送り直すこと',
  account_on_hold: 'アカウントが保留状態（account_on_hold）。手元で確認が要る',
  billing_error: '請求のエラー（billing_error）。手元で確認が要る',
  authentication_failed: '認証に失敗した。手元で /login が要る',
  oauth_org_not_allowed: '認証に失敗した（組織の制限）。手元で確認が要る',
  max_output_tokens: '出力が長すぎて途中で切れた。続きを頼めば再開できる',
};

export function hookToNotice(event: HookEvent, ctx: NoticeContext): HookNotice | undefined {
  switch (event.hook_event_name) {
    case 'Notification':
      return notificationNotice(event, ctx);
    case 'Stop':
      // 返事（reply ツール）無しで応答が終わった。無応答の見張りより早く知らせる
      return ctx.waiting ? { text: '⚠️ Slack に返事をしないまま応答が終わった。ターミナル側で止まっているかもしれない。', screenButton: true } : undefined;
    case 'StopFailure': {
      const code = event.error ?? 'unknown';
      const detail = STOP_FAILURE_TEXT[code] ?? `エラーで止まった（${code}）`;
      const extra = event.error_details ? `\n${event.error_details}` : '';
      return { text: `⛔ ${detail}${extra}`, screenButton: false };
    }
    case 'PostCompact':
      return { text: event.trigger === 'auto' ? '🧹 会話が長くなったので自動で圧縮した' : '🧹 会話を圧縮した', screenButton: false };
    case 'SessionStart':
      return sessionStartNotice(event);
    case 'SessionEnd':
      // /clear では SessionEnd（reason=clear）の直後に SessionStart（source=clear）が来て「会話をクリアした」を出すので、終了は出さない
      if (event.reason === 'clear') return undefined;
      return { text: `🛑 Claude Code のセッションが終了した（${event.reason ?? '理由不明'}）`, screenButton: false };
    default:
      return undefined;
  }
}

function notificationNotice(event: HookEvent, ctx: NoticeContext): HookNotice | undefined {
  const type = event.notification_type ?? '';
  if (type === 'permission_prompt') {
    // Slack に中継した許可でもターミナル側に同じ確認が出るので、中継中（pending）なら黙る
    return ctx.pending === 0 ? { text: `🔐 ${TERMINAL_WAITING}`, screenButton: true } : undefined;
  }
  if (type.startsWith('elicitation_') || type === 'agent_needs_input') {
    return { text: TERMINAL_WAITING, screenButton: true };
  }
  if (type === 'idle_prompt') {
    // 応答のたびに鳴るので、Slack に返事が無いときだけ
    return ctx.waiting ? { text: '⏳ Claude が入力待ちのまま止まっている。' + (event.message ?? ''), screenButton: true } : undefined;
  }
  if (type.startsWith('quota_auto_resume_')) {
    return { text: `⏱ ${event.message ?? type}`, screenButton: false };
  }
  return undefined;
}

function sessionStartNotice(event: HookEvent): HookNotice | undefined {
  switch (event.source) {
    case 'clear':
      return { text: '🧹 会話をクリアした（新しい会話）', screenButton: false };
    case 'compact':
      return undefined; // PostCompact で出す
    case 'startup':
    case 'resume':
    case 'fork':
    case undefined:
      return { text: `🟢 Claude Code のセッションを開始した${event.cwd ? `: ${event.cwd}` : ''}`, screenButton: false };
    default:
      return undefined;
  }
}
