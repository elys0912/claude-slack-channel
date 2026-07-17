// Claude Code の hook から受け取る情報のうち、ブリッジが使う分だけ（I/O なし。hook.ts と hook-inbox.ts の両方から使う）。
// 欄の定義はここの zod スキーマ 1 か所。型（HookEvent）と hook が stdin から写す欄（HOOK_STRING_FIELDS）はここから導く
import { z } from 'zod';

/** hook が stdin の JSON から写す文字列の欄（hook_event_name 以外） */
const COPIED_FIELDS = {
  session_id: z.string().optional(),
  /** Notification の種類（permission_prompt / idle_prompt / elicitation_* / quota_auto_resume_* など） */
  notification_type: z.string().optional(),
  /** Notification の本文 */
  message: z.string().optional(),
  /** SessionStart の起動理由（startup / resume / clear / compact / fork） */
  source: z.string().optional(),
  /** SessionEnd の理由 */
  reason: z.string().optional(),
  /** StopFailure のエラー種別（rate_limit / overloaded / ... / unknown） */
  error: z.string().optional(),
  error_details: z.string().optional(),
  /** PostCompact の起動理由（manual / auto） */
  trigger: z.string().optional(),
  cwd: z.string().optional(),
};

const HOOK_EVENT_SHAPE = {
  /** 記録した時刻（epoch ms。hook 側で付ける） */
  at: z.number(),
  hook_event_name: z.string().min(1),
  ...COPIED_FIELDS,
  /** 起動した start.ps1 の識別子（環境変数 SLACK_CHANNEL_SESSION_TAG）。stdin からは写さない。ブリッジは自分と同じ値の行だけ扱う */
  session_tag: z.string().optional(),
};

/** hooks.jsonl の 1 行を読むスキーマ。知らない欄があっても通す（Claude Code の版で欄が増えても読めるように） */
export const HookEventSchema = z.looseObject(HOOK_EVENT_SHAPE);

/** hooks.jsonl の 1 行。Claude Code の hook が stdin で受け取る JSON から、使う欄だけを写したもの */
export type HookEvent = z.infer<z.ZodObject<typeof HOOK_EVENT_SHAPE>>;

/** stdin の JSON から写す欄（文字列のものだけ） */
export const HOOK_STRING_FIELDS = ['hook_event_name', ...(Object.keys(COPIED_FIELDS) as (keyof typeof COPIED_FIELDS)[])] as const;

/** start.ps1 が起動ごとに一意の値を入れる環境変数。claude.exe から hook とブリッジの両方に引き継がれる */
export const SESSION_TAG_ENV = 'SLACK_CHANNEL_SESSION_TAG';

/** 状態ディレクトリに置く記録ファイルの名前 */
export const HOOK_LOG_FILE = 'hooks.jsonl';
