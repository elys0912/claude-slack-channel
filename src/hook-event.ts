// Claude Code の hook から受け取る情報のうち、ブリッジが使う分だけ（I/O なし。hook.ts と hook-inbox.ts の両方から使う）

/** hooks.jsonl の 1 行。Claude Code の hook が stdin で受け取る JSON から、使う欄だけを写したもの */
export interface HookEvent {
  /** 記録した時刻（epoch ms。hook 側で付ける） */
  at: number;
  hook_event_name: string;
  session_id?: string | undefined;
  /** Notification の種類（permission_prompt / idle_prompt / elicitation_* / quota_auto_resume_* など） */
  notification_type?: string | undefined;
  /** Notification の本文 */
  message?: string | undefined;
  /** SessionStart の起動理由（startup / resume / clear / compact / fork） */
  source?: string | undefined;
  /** SessionEnd の理由 */
  reason?: string | undefined;
  /** StopFailure のエラー種別（rate_limit / overloaded / ... / unknown） */
  error?: string | undefined;
  error_details?: string | undefined;
  /** PostCompact の起動理由（manual / auto） */
  trigger?: string | undefined;
  cwd?: string | undefined;
  /** 起動した start.ps1 の識別子（環境変数 SLACK_CHANNEL_SESSION_TAG）。ブリッジは自分と同じ値の行だけ扱う */
  session_tag?: string | undefined;
}

/** start.ps1 が起動ごとに一意の値を入れる環境変数。claude.exe から hook とブリッジの両方に引き継がれる */
export const SESSION_TAG_ENV = 'SLACK_CHANNEL_SESSION_TAG';

/** stdin の JSON から写す欄（文字列のものだけ） */
export const HOOK_STRING_FIELDS = [
  'hook_event_name',
  'session_id',
  'notification_type',
  'message',
  'source',
  'reason',
  'error',
  'error_details',
  'trigger',
  'cwd',
] as const;

/** 状態ディレクトリに置く記録ファイルの名前 */
export const HOOK_LOG_FILE = 'hooks.jsonl';
