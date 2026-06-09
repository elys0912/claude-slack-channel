// 設定・トークン・アクセス許可リストのロード。
// 注意: types.ts の AccessConfig には依存しない（別エージェントと並行編集中のため循環を避ける）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.SLACK_CHANNEL_STATE_DIR;
  if (dir) return dir;
  return path.join(os.homedir(), '.claude', 'channels', 'slack');
}

// 自前の .env パーサー。KEY=VALUE / # コメント / 空行 / 前後空白 / "..." '...' の引用符 /
// CRLF / BOM / `export ` 接頭辞に対応する。値の展開や複数行はしない。
export function parseDotenv(text: string): Record<string, string> {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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
    let value = line.slice(eq + 1).trim();
    if (!key) continue;

    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }

    result[key] = value;
  }

  return result;
}

export interface Tokens {
  botToken: string;
  appToken: string;
}

export function loadTokens(dir: string): Tokens {
  const file = path.join(dir, '.env');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`.env が見つからない: ${file}`);
  }

  const parsed = parseDotenv(text);

  const botToken = parsed.SLACK_BOT_TOKEN;
  if (!botToken) {
    throw new Error('SLACK_BOT_TOKEN が設定されていない');
  }
  if (!botToken.startsWith('xoxb-')) {
    throw new Error('SLACK_BOT_TOKEN の接頭辞が不正（xoxb- で始まる必要がある）');
  }

  const appToken = parsed.SLACK_APP_TOKEN;
  if (!appToken) {
    throw new Error('SLACK_APP_TOKEN が設定されていない');
  }
  if (!appToken.startsWith('xapp-')) {
    throw new Error('SLACK_APP_TOKEN の接頭辞が不正（xapp- で始まる必要がある）');
  }

  // process.env には書き込まない（子プロセスへ引き継がれるため）
  return { botToken, appToken };
}

export const AccessSchema = z.strictObject({
  teamId: z.string().regex(/^[TE][A-Z0-9]{2,}$/, 'teamId の形式が不正'),
  allowFrom: z
    .array(z.string().regex(/^[UW][A-Z0-9]{2,}$/, 'allowFrom のID形式が不正'))
    .min(1, 'allowFrom は1件以上必要')
    .refine((arr) => new Set(arr).size === arr.length, {
      message: 'allowFrom に重複がある',
    }),
});

export type ParsedAccess = z.infer<typeof AccessSchema>;

export function loadAccess(dir: string): ParsedAccess {
  const file = path.join(dir, 'access.json');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`access.json が見つからない: ${file}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`access.json の JSON 構文が不正: ${(e as Error).message}`);
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
