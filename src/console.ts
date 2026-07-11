// Claude Code と共有しているコンソールの画面を読む・選択キーを送る（scripts/console.ps1 を子プロセスで呼ぶ）。
// Slack に中継されないターミナル側の選択画面（Claude in Chrome の案内など）で止まったときに、Slack から解除するために使う。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 送れるキー。自由な文字入力は送らない */
export type ConsoleKey = 'Up' | 'Down' | 'Enter';

export interface ConsoleAccess {
  /** 表示中の範囲の文字（行末の空白は除く） */
  read(): Promise<string>;
  sendKeys(keys: ConsoleKey[]): Promise<void>;
}

const TIMEOUT_MS = 20000;

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

  constructor(script: string) {
    this.script = script;
  }

  read(): Promise<string> {
    return this.run(['-Mode', 'read']);
  }

  async sendKeys(keys: ConsoleKey[]): Promise<void> {
    if (keys.length === 0) return;
    await this.run(['-Mode', 'keys', '-Keys', keys.join(',')]);
  }

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script, ...args],
        { windowsHide: false, timeout: TIMEOUT_MS, encoding: 'utf8', maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const detail = stderr.trim().split(/\r?\n/)[0] ?? '';
            reject(new Error(`console.ps1 の実行に失敗: ${detail || err.message}`, { cause: err }));
            return;
          }
          resolve(stdout.replace(/\r\n/g, '\n'));
        }
      );
    });
  }
}
