// 文字列の小さな整形（I/O なし）。設定ファイルの読み込みと Slack 表示の両方から使う
import { randomBytes } from 'node:crypto';

/** 先頭の BOM（メモ帳などが付ける U+FEFF）を取り除く */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 先頭から max 文字（UTF-16 単位）までを返す。末尾がサロゲートペアの前半なら、それも落とす（壊れた文字を残さない） */
export function truncateUnits(text: string, max: number): string {
  const head = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/** max 文字（UTF-16 単位）に収める。超えたら末尾を … にし、サロゲートペアの途中では切らない */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${truncateUnits(text, Math.max(0, max - 1))}…`;
}

/** ブリッジが発行する控え・提案の ID の長さ */
export const TOKEN_ID_LENGTH = 8;
/** 控え・提案の ID の正規表現の本体（英小文字と数字 TOKEN_ID_LENGTH 文字）。ほかの値と組み合わせた形の照合にも使う */
export const TOKEN_ID_BODY = `[a-z0-9]{${TOKEN_ID_LENGTH}}`;
/** 画面の控え・提案の ID（newToken が作る形） */
export const TOKEN_ID_RE = new RegExp(`^${TOKEN_ID_BODY}$`);
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

/** 1 秒のミリ秒（秒単位の時刻・秒数とミリ秒の換算に使う） */
export const MS_PER_SECOND = 1000;
/** 1 分のミリ秒（待ち時間・経過時間の分への換算に使う） */
export const MS_PER_MINUTE = 60000;

/** 日時を `YYYY-MM-DD HH:mm`（ローカル時刻）にする */
export function formatTime(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
