// 文字列の小さな整形（I/O なし）。設定ファイルの読み込みと Slack 表示の両方から使う
import { randomBytes } from 'node:crypto';

/** 先頭の BOM（メモ帳などが付ける U+FEFF）を取り除く */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** max 文字（UTF-16 単位）に収める。超えたら末尾を … にし、サロゲートペアの途中では切らない */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = Math.max(0, max - 1);
  const code = text.charCodeAt(cut - 1);
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

/** ブリッジが発行する控え・提案の ID の長さ（permission.ts の TOKEN_ID_RE と対応） */
export const TOKEN_ID_LENGTH = 8;
/** base64url で TOKEN_ID_LENGTH 文字以上になる乱数のバイト数（6 バイト → 8 文字） */
const TOKEN_RANDOM_BYTES = 6;

/** ブリッジが発行する控え・提案の ID（英小文字と数字 TOKEN_ID_LENGTH 文字） */
export function newToken(): string {
  return randomBytes(TOKEN_RANDOM_BYTES)
    .toString('base64url')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '0')
    .slice(0, TOKEN_ID_LENGTH)
    .padEnd(TOKEN_ID_LENGTH, '0');
}
