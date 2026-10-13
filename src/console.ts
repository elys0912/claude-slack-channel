// Claude Code のコンソールの画面を読む・選択キーを送る（scripts/console.ps1 を子プロセスで呼ぶ）。
// Slack に中継されないターミナル側の選択画面（Claude in Chrome の案内など）で止まったときに、Slack から解除するために使う。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from './log.js';
import { powershellExe } from './system-exe.js';

/** 送れるキー。自由な文字入力は送らない */
export type ConsoleKey = 'Up' | 'Down' | 'Enter';
/** 送れるスラッシュコマンド（固定。console.ps1 側でも同じ一覧に限っている） */
export type ConsoleCommand = 'exit' | 'compact' | 'clear';

export interface ConsoleAccess {
  /** 表示中の範囲の文字（行末の空白は除く） */
  read(): Promise<string>;
  sendKeys(keys: ConsoleKey[]): Promise<void>;
  /** `/exit` や `/compact` を打って Enter を送る */
  sendCommand(command: ConsoleCommand): Promise<void>;
}

const TIMEOUT_MS = 20000;
/** console.ps1 の出力（画面 1 枚分のテキスト）の上限 */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * scripts/console.ps1 の場所。ビルド後（dist/src/console.js）とテスト時（src/console.ts）の両方から探す。
 * 見つからなければ undefined。
 */
export function findConsoleScript(fromDir: string = path.dirname(fileURLToPath(import.meta.url))): string | undefined {
  const candidates = [
    path.resolve(fromDir, '..', '..', 'scripts', 'console.ps1'),
    path.resolve(fromDir, '..', 'scripts', 'console.ps1'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

/**
 * PowerShell の子プロセスで console.ps1 を実行する実装。
 * 子プロセスが親（ブリッジ）のコンソールを引き継ぐよう windowsHide は false にする
 * （true だと CREATE_NO_WINDOW で別のコンソールが作られ、Claude Code の画面を読めない）。
 */
export class PowerShellConsole implements ConsoleAccess {
  private readonly script: string;
  private readonly targetPid: number | undefined;
  private readonly logger: Pick<Logger, 'warn'> | undefined;

  /**
   * targetPid は Claude Code（claude.exe）の pid。Claude Code は MCP サーバーを別のコンソールで起動することがあり、
   * そのままではブリッジのコンソール（空）を読んでしまうので、console.ps1 にそのプロセスのコンソールへ付け直させる。
   * logger には、成功しても console.ps1 が stderr に書いた警告（付け直せなかった、など）を残す
   */
  constructor(script: string, targetPid?: number, logger?: Pick<Logger, 'warn'>) {
    this.script = script;
    this.targetPid = targetPid;
    this.logger = logger;
  }

  read(): Promise<string> {
    return this.run(['-Mode', 'read']);
  }

  async sendKeys(keys: ConsoleKey[]): Promise<void> {
    if (keys.length === 0) return;
    await this.run(['-Mode', 'keys', '-Keys', keys.join(',')]);
  }

  async sendCommand(command: ConsoleCommand): Promise<void> {
    await this.run(['-Mode', 'command', '-Command', command]);
  }

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        powershellExe(),
        [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script, ...args,
          ...(this.targetPid !== undefined ? ['-TargetPid', String(this.targetPid)] : []),
        ],
        { windowsHide: false, timeout: TIMEOUT_MS, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES },
        (err, stdout, stderr) => {
          if (err) {
            const detail = stderr.trim().split(/\r?\n/)[0] ?? '';
            reject(new Error(`console.ps1 の実行に失敗: ${detail || err.message}`, { cause: err }));
            return;
          }
          // 付け直せないと、console.ps1 は自分のコンソールのまま続けて 0 で終わる。原因を追えるよう警告を残す
          const warning = stderr.trim();
          if (warning !== '') this.logger?.warn(`console.ps1 の警告: ${warning.split(/\r?\n/)[0]}`);
          resolve(stdout.replace(/\r\n/g, '\n'));
        }
      );
    });
  }
}
