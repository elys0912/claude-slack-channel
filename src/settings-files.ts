// Claude Code の settings JSON（ユーザー・プロジェクト・managed settings）と、ブリッジの状態ファイルの JSON を読む。
// 壊れたファイルを「空」と取り違えないよう、読めない・JSON でないときは投げる。
// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
import fs from 'node:fs';
import path from 'node:path';
import { stripBom } from './text.js';
import { errMessage } from './errors.js';

/**
 * JSON ファイルを読む（BOM 付きでも可）。ファイルが無ければ undefined。
 * 読めない・JSON でないときは投げる（壊れたファイルを「空」と取り違えて、deny の照合抜けや既存ルールの消失を起こさないため）
 */
export function readJson(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${file} を読めない: ${errMessage(e)}`, { cause: e });
  }
  try {
    return JSON.parse(stripBom(text)) as unknown;
  } catch (e) {
    throw new Error(`${file} の JSON 構文が不正: ${errMessage(e)}`, { cause: e });
  }
}

/** 配列のうち文字列だけを返す（配列でなければ空） */
export function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** 設定ファイル（Claude Code の settings JSON）の permissions.deny を読む。ファイルが無ければ空、読めない・JSON でなければ投げる */
export function readDeny(file: string): string[] {
  return stringsOf((readJson(file) as { permissions?: { deny?: unknown } } | undefined)?.permissions?.deny);
}

/** 設定ファイルの permissions.ask を読む。ファイルが無ければ空、読めない・JSON でなければ投げる */
export function readAsk(file: string): string[] {
  return stringsOf((readJson(file) as { permissions?: { ask?: unknown } } | undefined)?.permissions?.ask);
}

/**
 * managed settings（組織の管理設定）の置き場所の候補（Claude Code の仕様。OS ごと）。どれも、在れば読む。
 * Windows の `C:\ProgramData\ClaudeCode` は古い版の置き場所（版ごとの置き場所は未確認なので、両方を読む）
 */
const MANAGED_SETTINGS_DIRS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  win32: ['C:\\Program Files\\ClaudeCode', 'C:\\ProgramData\\ClaudeCode'],
  darwin: ['/Library/Application Support/ClaudeCode'],
  linux: ['/etc/claude-code'],
};
const MANAGED_SETTINGS_FILE = 'managed-settings.json';
/** managed-settings.json に重ねるファイルを置くフォルダー（中の *.json を名前順に読む） */
const MANAGED_SETTINGS_DROPIN_DIR = 'managed-settings.d';

/**
 * managed settings のファイルの一覧（フォルダーごとに managed-settings.json と managed-settings.d の *.json）。
 * 無いファイル・フォルダーは readAsk / readDeny が空として扱う。managed-settings.d が読めない（ENOENT 以外）ときは投げる。
 * レジストリやサーバーから配る managed settings は読まない
 */
export function managedSettingsFiles(dirs: readonly string[] = MANAGED_SETTINGS_DIRS[process.platform] ?? []): string[] {
  return dirs.flatMap((dir) => {
    const dropInDir = path.join(dir, MANAGED_SETTINGS_DROPIN_DIR);
    let dropIns: string[];
    try {
      dropIns = fs
        .readdirSync(dropInDir)
        .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
        .sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${dropInDir} を読めない: ${errMessage(e)}`, { cause: e });
      dropIns = [];
    }
    return [path.join(dir, MANAGED_SETTINGS_FILE), ...dropIns.map((name) => path.join(dropInDir, name))];
  });
}
