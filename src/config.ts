// 設定・トークン・アクセス許可リストのロード。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { errMessage } from './errors.js';
import { stripBom } from './text.js';

/** 状態ディレクトリの既定の場所（ホームからの相対。scripts/start.ps1 の $DefaultStateDirRelative と同じ値にすること） */
const DEFAULT_STATE_DIR_RELATIVE = ['.claude', 'channels', 'slack'];

/**
 * 状態ディレクトリ（.env / access.json / logs / instance.lock の置き場所）を返す。
 * SLACK_CHANNEL_STATE_DIR があれば path.resolve で絶対パスにして使う（相対パスはこのプロセスのカレントディレクトリ基準）。
 * 無ければ `~/.claude/channels/slack`。
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.SLACK_CHANNEL_STATE_DIR;
  if (dir) return path.resolve(dir);
  return path.join(os.homedir(), ...DEFAULT_STATE_DIR_RELATIVE);
}

// `=` より右側を値として解釈する。引用符で囲まれていれば中身を返し、閉じ引用符の後ろの ` # ...` は捨てる。
// 引用符が無ければ、空白に続く `#` 以降を行末コメントとして捨てる（`a#b` のように空白が無い `#` は値の一部）。
function parseValue(raw: string): string {
  const value = raw.trim();
  const first = value[0];
  if (first === '"' || first === "'") {
    const close = value.indexOf(first, 1);
    if (close !== -1) {
      const rest = value.slice(close + 1).trim();
      if (rest === '' || rest.startsWith('#')) return value.slice(1, close);
    }
    // 途中に同じ引用符を含む `"a"b"` などは従来どおり両端の引用符だけを剥がす
    return value.length >= 2 && value.endsWith(first) ? value.slice(1, -1) : value;
  }
  const comment = raw.search(/(^|\s)#/);
  return (comment === -1 ? raw : raw.slice(0, comment)).trim();
}

// 自前の .env パーサー。KEY=VALUE / # コメント（行頭・値の後ろ）/ 空行 / 前後空白 / "..." '...' の引用符 /
// CRLF / BOM / `export ` 接頭辞に対応する。値の展開や複数行はしない。
export function parseDotenv(text: string): Record<string, string> {
  const stripped = stripBom(text);
  const result: Record<string, string> = {};

  for (const rawLine of stripped.split(/\r\n|\r|\n/)) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    if (line.startsWith('export ')) {
      line = line.slice('export '.length).trim();
    }

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    result[key] = parseValue(line.slice(eq + 1));
  }

  return result;
}

export interface Tokens {
  botToken: string;
  appToken: string;
  /**
   * Slack の添付を保存するフォルダー（.env の DOWNLOAD_DIR を絶対パスにしたもの）。
   * 設定されているときだけ download_file ツールを出す（files:read スコープが要るため、使うボットだけで有効にする）
   */
  downloadDir?: string;
  /** .env の SESSION_ALLOW_ALL が on / true / 1 なら、実行許可に「このセッション中は全部許可」ボタンを出す */
  sessionAllowAll?: boolean;
}

/**
 * dir/.env から SLACK_BOT_TOKEN（xoxb-）と SLACK_APP_TOKEN（xapp-）、任意の DOWNLOAD_DIR を読む。環境変数は見ない。
 * ファイルが読めない・キーが無い・接頭辞が違う・DOWNLOAD_DIR が絶対パスでないときは投げる（メッセージにトークンの値は含めない）。
 */
export function loadTokens(dir: string): Tokens {
  const file = path.join(dir, '.env');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`.env が見つからない: ${file}`, { cause: e });
  }

  const parsed = parseDotenv(text);
  // process.env には書き込まない（子プロセスへ引き継がれるため）
  const tokens: Tokens = {
    botToken: requireToken(parsed, 'SLACK_BOT_TOKEN', 'xoxb-'),
    appToken: requireToken(parsed, 'SLACK_APP_TOKEN', 'xapp-'),
  };
  const downloadDir = parsed.DOWNLOAD_DIR;
  if (downloadDir) {
    // 相対パスはカレントディレクトリ（起動したプロジェクト）次第で保存先が変わるので受け付けない
    if (!path.isAbsolute(downloadDir)) throw new Error('DOWNLOAD_DIR は絶対パスで指定する');
    tokens.downloadDir = path.resolve(downloadDir);
  }
  if (/^(on|true|1)$/i.test(parsed.SESSION_ALLOW_ALL ?? '')) tokens.sessionAllowAll = true;
  return tokens;
}

/** .env の値のうち、key が設定されていて prefix で始まるものを返す。無い・接頭辞が違えば投げる（値は含めない） */
function requireToken(parsed: Record<string, string>, key: string, prefix: string): string {
  const value = parsed[key];
  if (!value) throw new Error(`${key} が設定されていない`);
  if (!value.startsWith(prefix)) throw new Error(`${key} の接頭辞が不正（${prefix} で始まる必要がある）`);
  return value;
}

/**
 * access.json のスキーマ。未知のキーはエラー（strictObject）。
 * teamId はワークスペース ID（T...）、allowFrom はユーザー ID（U...）のみで、1 件以上・重複不可。
 * Enterprise Grid の組織 ID（E...）やグリッドのユーザー ID（W...）は受信イベントの team_id / user と一致しないため不可。
 * channels は DM に加えて使うチャンネルの ID（C...、古い非公開チャンネルは G...）で、省略時は DM のみ。重複不可。
 */
export const AccessSchema = z.strictObject({
  teamId: z.string().regex(/^T[A-Z0-9]{2,}$/, 'teamId の形式が不正（T で始まるワークスペース ID）'),
  allowFrom: z
    .array(z.string().regex(/^U[A-Z0-9]{2,}$/, 'allowFrom のID形式が不正（U で始まるユーザー ID）'))
    .min(1, 'allowFrom は1件以上必要')
    .refine((arr) => new Set(arr).size === arr.length, {
      message: 'allowFrom に重複がある',
    }),
  channels: z
    .array(z.string().regex(/^[CG][A-Z0-9]{2,}$/, 'channels のID形式が不正（C で始まるチャンネル ID）'))
    .refine((arr) => new Set(arr).size === arr.length, {
      message: 'channels に重複がある',
    })
    .optional(),
});

export type ParsedAccess = z.infer<typeof AccessSchema>;

/** 状態ディレクトリの home.json（ホームタブの文面の差し替え）のスキーマ。未知のキーはエラー */
export const HomeCustomSchema = z.strictObject({
  header: z.string().min(1).max(150).optional(),
  running: z.string().min(1).optional(),
  stopped: z.string().min(1).optional(),
  greetings: z.array(z.string().min(1)).max(100).optional(),
  body: z.array(z.string()).max(100).optional(),
  footer: z.string().min(1).optional(),
});

export type ParsedHomeCustom = z.infer<typeof HomeCustomSchema>;

/**
 * dir/home.json を読む。ファイルが無ければ undefined（既定の文面を使う）。
 * 読めない・JSON が壊れている・スキーマ違反のときは投げる（呼び出し側でログに残して既定の文面にする）。
 */
export function loadHomeCustom(dir: string): ParsedHomeCustom | undefined {
  const file = path.join(dir, 'home.json');
  if (!fs.existsSync(file)) return undefined;
  const json: unknown = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  const result = HomeCustomSchema.safeParse(json);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`home.json の検証に失敗: ${details}`);
  }
  return result.data;
}

/**
 * dir/access.json を読み、AccessSchema で検証して返す。先頭の BOM は取り除いてから JSON として解釈する。
 * 次の場合は投げる: ファイルが読めない（`access.json が見つからない`）、JSON 構文エラー（`JSON 構文が不正`）、
 * スキーマ違反（`access.json の検証に失敗: <パス>: <理由>; ...`）。
 */
export function loadAccess(dir: string): ParsedAccess {
  const file = path.join(dir, 'access.json');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`access.json が見つからない: ${file}`, { cause: e });
  }

  let json: unknown;
  try {
    json = JSON.parse(stripBom(text));
  } catch (e) {
    throw new Error(`access.json の JSON 構文が不正: ${errMessage(e)}`, { cause: e });
  }

  const result = AccessSchema.safeParse(json);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`access.json の検証に失敗: ${details}`);
  }

  return result.data;
}
