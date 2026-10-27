// 想定外の終了から起動し直したことの知らせ。start.ps1 が claude.exe の想定外の終了（exit code が 0 以外）で
// 起動し直すときに状態ディレクトリへ crash.json を置き、起動したブリッジがそれを読んで知らせてから消す
// （終了したセッションのブリッジは claude.exe と一緒に止まっているので、知らせられるのは次のブリッジだけ）。
import fs from 'node:fs';
import { stripBom } from './text.js';

/** start.ps1 が置く印（状態ディレクトリ） */
export const CRASH_FILE = 'crash.json';

/** crash.json の中身（start.ps1 が書く） */
export interface CrashRecord {
  /** 終了した時刻（epoch ms） */
  at: number;
  exit_code: number;
  /** 直近の窓の中で起動し直した回数（今回を含む） */
  count: number;
  /** 窓の中で起動し直す上限 */
  max: number;
  /** 窓の長さ（分） */
  window_min: number;
  /** 同じ会話を --resume で開いたか */
  resumed: boolean;
}

function isCrashRecord(value: unknown): value is CrashRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.at === 'number' &&
    typeof r.exit_code === 'number' &&
    typeof r.count === 'number' &&
    typeof r.max === 'number' &&
    typeof r.window_min === 'number' &&
    typeof r.resumed === 'boolean'
  );
}

/** 知らせの文 */
export function crashNoticeText(r: CrashRecord): string {
  const session = r.resumed ? '同じ会話を開いた' : '引き継ぐ会話の記録が無いので新しい会話で起動した';
  return `♻️ Claude Code が想定外に終了した（exit code ${r.exit_code}）ので起動し直した（${r.window_min} 分で ${r.count}/${r.max} 回目。${session}）`;
}

/** crash.json を読んで消し、知らせの文を返す。無い・壊れていれば undefined（壊れていても消す） */
export function takeCrashNotice(file: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  fs.rmSync(file, { force: true });
  try {
    // PowerShell 5.1 の Set-Content -Encoding UTF8 は BOM を付けるので外す
    const parsed: unknown = JSON.parse(stripBom(text));
    return isCrashRecord(parsed) ? crashNoticeText(parsed) : undefined;
  } catch {
    return undefined;
  }
}
