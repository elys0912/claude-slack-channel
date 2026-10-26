// stderr / ファイルへ書き出すロガー。
// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
import fs from 'node:fs';
import path from 'node:path';
import { redactChannelSecrets } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** 文字列をログのレベルにする（大文字・小文字は問わない）。空・知らない値なら undefined */
export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  const v = value?.trim().toLowerCase();
  return v !== undefined && Object.hasOwn(LEVEL_ORDER, v) ? (v as LogLevel) : undefined;
}

// 画面の中継（!screen）にも使うので、ターミナルに出やすいほかの鍵の形も伏せる。
// GitHub のトークン（ghp_ / gho_ / ghu_ / ghs_ / ghr_ と github_pat_）、AWS のアクセスキー ID（AKIA / ASIA + 16 文字）、
// sk- で始まる API キー（Anthropic・OpenAI など。普通の語を伏せないよう 20 文字以上に限る）
const GITHUB_TOKEN_RE = /\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/g;
const AWS_ACCESS_KEY_RE = /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g;
const SK_API_KEY_RE = /\bsk-[A-Za-z0-9_-]{20,}/g;

/** ログと画面の中継に出す前に、トークンや鍵の形を伏せる（チャネル固有の形は redact.ts） */
export function redact(s: string): string {
  return redactChannelSecrets(s)
    .replace(GITHUB_TOKEN_RE, (_m, prefix: string) => `${prefix}***`)
    .replace(AWS_ACCESS_KEY_RE, (_m, prefix: string) => `${prefix}***`)
    .replace(SK_API_KEY_RE, 'sk-***');
}

// 循環参照があっても落ちない JSON.stringify
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val: unknown) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val;
    });
  } catch {
    return String(value);
  }
}

function formatArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
  return safeStringify(a);
}

export interface LoggerOptions {
  file?: string;
  level?: LogLevel;
  maxBytes?: number; // 既定 5MB
  stderr?: boolean; // 既定 true
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export class Logger {
  private file: string | undefined;
  private level: LogLevel;
  private maxBytes: number;
  private toStderr: boolean;
  private name = '';

  constructor(opts: LoggerOptions = {}) {
    this.file = opts.file;
    this.level = opts.level ?? 'info';
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.toStderr = opts.stderr ?? true;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setName(name: string): void {
    this.name = name;
  }

  debug(...a: unknown[]): void {
    this.write('debug', a);
  }

  info(...a: unknown[]): void {
    this.write('info', a);
  }

  warn(...a: unknown[]): void {
    this.write('warn', a);
  }

  error(...a: unknown[]): void {
    this.write('error', a);
  }

  private write(level: LogLevel, args: unknown[]): void {
    try {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

      const ts = new Date().toISOString();
      const msg = args.map(formatArg).join(' ');
      const line = redact(`${ts} ${level.toUpperCase()} [${this.name}] ${msg}`);

      if (this.toStderr) {
        try {
          process.stderr.write(`${line}\n`);
        } catch {
          // stderr への書き込み失敗も呼び出し元へは伝えない
        }
      }

      if (this.file) {
        this.writeToFile(this.file, `${line}\n`);
      }
    } catch {
      // ログ出力自体で例外が起きても呼び出し元に投げない
    }
  }

  private writeToFile(file: string, line: string): void {
    try {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      try {
        const stat = fs.statSync(file);
        if (stat.size > this.maxBytes) {
          const rotated = `${file}.1`;
          try {
            fs.renameSync(file, rotated);
          } catch {
            // ローテーション失敗は無視して書き込みを続ける
          }
        }
      } catch {
        // ファイルがまだ無いだけなら何もしない
      }

      fs.appendFileSync(file, line);
    } catch {
      // ファイル書き込みの失敗も呼び出し元へは伝えない
    }
  }
}
