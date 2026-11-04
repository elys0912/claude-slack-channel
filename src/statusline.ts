// Claude Code の statusline として起動されるコマンド（dist/src/statusline.js）。
// start.ps1 が --settings に注入する statusLine から呼ばれ、stdin の JSON（コンテキストの使用率・使用量の 5 時間枠と 7 日枠）から
// 使う欄だけを状態ディレクトリの usage.json に書く。ブリッジ（usage-watch.ts）がそれを読んで Slack に知らせる。
// stdout に書いた 1 行が Claude Code の画面の statusline になる。失敗しても exit 0（statusline の失敗でセッションを止めない）。
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './config.js';
import { SESSION_TAG_ENV } from './hook-event.js';
import { errMessage } from './errors.js';
import { isObject } from './state-file.js';
import { isMainModule } from './main-module.js';

/** 状態ディレクトリに置く使用量の記録 */
export const USAGE_FILE = 'usage.json';

/** 使用量の枠（5 時間・7 日） */
export interface UsageWindow {
  /** 使った割合（0〜100） */
  used: number;
  /** 枠がリセットされる時刻（Unix 秒） */
  resets_at: number;
}

/** usage.json の中身。Claude Code が渡さなかった欄は書かない */
export interface UsageSnapshot {
  /** 記録した時刻（epoch ms） */
  at: number;
  session_tag?: string;
  session_id?: string;
  /** コンテキストの使用率（入力トークンだけの割合。序盤は Claude Code が null を渡すので書かない） */
  context?: { used: number; size?: number };
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toWindow(value: unknown): UsageWindow | undefined {
  if (!isObject(value)) return undefined;
  const used = finiteNumber(value.used_percentage);
  const resetsAt = finiteNumber(value.resets_at);
  return used === undefined || resetsAt === undefined ? undefined : { used, resets_at: resetsAt };
}

/**
 * statusline の stdin の JSON を UsageSnapshot にする。JSON でなければ undefined。tag があれば session_tag に記録する。
 * rate_limits は Pro / Max のときだけ、かつ最初の API 応答の後にだけ来る（無ければ five_hour・seven_day を書かない）
 */
export function toUsageSnapshot(stdinText: string, now: number = Date.now(), tag?: string): UsageSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdinText);
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;

  const snapshot: UsageSnapshot = { at: now };
  if (tag) snapshot.session_tag = tag;
  if (typeof parsed.session_id === 'string' && parsed.session_id !== '') snapshot.session_id = parsed.session_id;

  const context = parsed.context_window;
  if (isObject(context)) {
    const used = finiteNumber(context.used_percentage);
    const size = finiteNumber(context.context_window_size);
    if (used !== undefined) snapshot.context = size === undefined ? { used } : { used, size };
  }
  const limits = parsed.rate_limits;
  if (isObject(limits)) {
    const fiveHour = toWindow(limits.five_hour);
    const sevenDay = toWindow(limits.seven_day);
    if (fiveHour) snapshot.five_hour = fiveHour;
    if (sevenDay) snapshot.seven_day = sevenDay;
  }
  return snapshot;
}

/** 画面の statusline に出す 1 行（例: `ctx 42% · 5h 63% · 7d 41%`）。分からない欄は出さない */
export function formatStatusLine(snapshot: UsageSnapshot): string {
  const parts: string[] = [];
  if (snapshot.context) parts.push(`ctx ${Math.round(snapshot.context.used)}%`);
  if (snapshot.five_hour) parts.push(`5h ${Math.round(snapshot.five_hour.used)}%`);
  if (snapshot.seven_day) parts.push(`7d ${Math.round(snapshot.seven_day.used)}%`);
  return parts.join(' · ');
}

/** 記録時刻を除いた中身（変わったときだけ書くための比較用） */
function contentKey(snapshot: UsageSnapshot): string {
  return JSON.stringify({ ...snapshot, at: 0 });
}

/**
 * usage.json に書く。記録時刻以外が前と同じなら書かない（statusline は頻繁に呼ばれるため）。
 * 一時ファイルに書いてから置き換える（ブリッジに書きかけを読ませない）。置き換えられなければ直接書く
 * （Windows では読み手が開いている間の置き換えが失敗しうる）。書いたら true
 */
export function writeUsage(dir: string, snapshot: UsageSnapshot): boolean {
  const file = path.join(dir, USAGE_FILE);
  try {
    const previous = JSON.parse(fs.readFileSync(file, 'utf8')) as UsageSnapshot;
    if (contentKey(previous) === contentKey(snapshot)) return false;
  } catch {
    // 無い・壊れているなら書く
  }

  fs.mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(snapshot) + '\n';
  // state-file.ts の writeFileAtomic は使わない。一時ファイルの名前と、置き換えに失敗したときの後始末・直接書きが違うため。
  // 一時ファイルに書けなければ投げる（main() が「記録に失敗」を出す）
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  try {
    fs.renameSync(temp, file);
  } catch {
    fs.rmSync(temp, { force: true });
    fs.writeFileSync(file, text);
  }
  return true;
}

function main(): void {
  let line = '';
  try {
    const snapshot = toUsageSnapshot(fs.readFileSync(0, 'utf8'), Date.now(), process.env[SESSION_TAG_ENV]);
    if (snapshot) {
      line = formatStatusLine(snapshot);
      writeUsage(stateDir(), snapshot);
    }
  } catch (e) {
    process.stderr.write(`[slackbridge statusline] 記録に失敗: ${errMessage(e)}\n`);
  }
  process.stdout.write(line + '\n');
  process.exit(0);
}

// statusline として直接起動されたときだけ動く（テストや他モジュールからの import では動かない）
if (isMainModule(import.meta.url)) {
  main();
}
