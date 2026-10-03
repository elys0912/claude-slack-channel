// Claude Code の hook として起動されるコマンド（dist/src/hook.js）。
// start.ps1 が --settings に注入する hooks（SessionStart / SessionEnd / Stop / StopFailure / Notification / PostCompact）から
// 呼ばれ、stdin の JSON から使う欄だけを状態ディレクトリの hooks.jsonl に 1 行追記する。ブリッジ（hook-inbox.ts）がそれを読んで Slack に出す。
// stdout には何も書かない（hook の stdout は Claude Code が解釈する）。失敗しても exit 0（hook の失敗でセッションを止めない）。
import './stdio-guard.js';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateDir } from './config.js';
import { HOOK_LOG_FILE, HOOK_STRING_FIELDS, SESSION_TAG_ENV } from './hook-event.js';
import type { HookEvent } from './hook-event.js';
import { errMessage } from './errors.js';

/** hooks.jsonl がこれを超えたら hooks.jsonl.1 に回す（log.ts と同じ 1 世代） */
export const HOOK_LOG_MAX_BYTES = 1024 * 1024;
/** message / error_details など自由文の欄の長さの上限（1 行を膨らませない） */
const FIELD_MAX = 500;

/** stdin の JSON を HookEvent にする。JSON でない・hook_event_name が無ければ undefined。tag があれば session_tag に記録する */
export function toHookEvent(stdinText: string, now: number = Date.now(), tag?: string): HookEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdinText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.hook_event_name !== 'string' || raw.hook_event_name === '') return undefined;

  const event: HookEvent = { at: now, hook_event_name: raw.hook_event_name };
  for (const field of HOOK_STRING_FIELDS) {
    const value = raw[field];
    if (typeof value === 'string' && field !== 'hook_event_name') event[field] = value.slice(0, FIELD_MAX);
  }
  // error_details は版によってオブジェクト（{"status":429,"message":"..."} など）の例がある。message か JSON にして写す
  const details = raw.error_details;
  if (typeof details === 'object' && details !== null) {
    const message = (details as Record<string, unknown>).message;
    event.error_details = (typeof message === 'string' ? message : JSON.stringify(details)).slice(0, FIELD_MAX);
  }
  if (tag) event.session_tag = tag.slice(0, FIELD_MAX);
  return event;
}

/** 1 行追記する。ファイルが大きくなっていれば先に回す。JSON でない入力は何もしない */
export function appendHookLine(dir: string, stdinText: string, now: number = Date.now(), tag?: string): HookEvent | undefined {
  const event = toHookEvent(stdinText, now, tag);
  if (!event) return undefined;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, HOOK_LOG_FILE);
  rotateIfLarge(file);
  fs.appendFileSync(file, JSON.stringify(event) + '\n');
  return event;
}

function rotateIfLarge(file: string): void {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size <= HOOK_LOG_MAX_BYTES) return;
  try {
    fs.renameSync(file, `${file}.1`);
  } catch {
    // 回せなくても追記は続ける
  }
}

function main(): void {
  try {
    const text = fs.readFileSync(0, 'utf8');
    appendHookLine(stateDir(), text, Date.now(), process.env[SESSION_TAG_ENV]);
  } catch (e) {
    process.stderr.write(`[slackbridge hook] 記録に失敗: ${errMessage(e)}\n`);
  }
  process.exit(0);
}

// hook として直接起動されたときだけ動く（テストや他モジュールからの import では動かない）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
