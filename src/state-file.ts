// 状態ディレクトリの小さな JSON ファイル（ロック・usage.json・crash.json）の読み書き。
// 読みは「無い・壊れている・形が違う」をまとめて undefined にし、書きは一時ファイルからの置き換えで書きかけを読ませない。
// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
import fs from 'node:fs';
import path from 'node:path';

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** JSON の文字列を読み、guard に合えば返す。JSON でない・形が違えば undefined */
export function parseJson<T>(text: string, guard: (value: unknown) => value is T): T | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return guard(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** JSON ファイルを読み、guard に合えば返す。無い・読めない・JSON でない・形が違えば undefined */
export function readJsonFile<T>(file: string, guard: (value: unknown) => value is T): T | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  return parseJson(text, guard);
}

/**
 * 同じフォルダーの一時ファイル（`.<name>.tmp.<pid>.<乱数>`）に書いてから置き換える（読み手に書きかけを見せない）。
 * フォルダーは呼び出し側で作る。置き換えに失敗したら一時ファイルを残したまま投げる
 * （Windows では読み手が開いている間の置き換えが失敗しうる）。後始末をしないのは、切り出す前の lock.ts の動きを変えないため
 */
export function writeFileAtomic(file: string, text: string, pid: number = process.pid): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp.${pid}.${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
