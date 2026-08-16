// テストから scripts/*.ps1 を powershell.exe で動かす（common-script・start-script・console-script のテストで共用）。
// -NoProfile と -ExecutionPolicy Bypass は、テストを動かす人のプロファイルや実行ポリシーで結果が変わらないようにするため。
// -NonInteractive は、スクリプトが入力を待ったときに固まらず失敗させるため
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { describe } from 'vitest';

const POWERSHELL_OPTIONS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

/** powershell.exe -File で script を実行する（ブリッジ・dialog-answer.ps1 と同じ渡し方） */
export function runPowerShellFile(script: string, args: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): SpawnSyncReturns<string> {
  return spawnSync('powershell.exe', [...POWERSHELL_OPTIONS, '-File', script, ...args], { encoding: 'utf8', windowsHide: true, env });
}

/** powershell.exe -Command で command を実行する */
export function runPowerShellCommand(command: string): SpawnSyncReturns<string> {
  return spawnSync('powershell.exe', [...POWERSHELL_OPTIONS, '-Command', command], { encoding: 'utf8', windowsHide: true });
}

/**
 * Windows でだけ動かす describe（powershell.exe が要るため）。
 * powershell.exe の起動は CI の初回だと 5 秒を超えることがあるので、時間の上限（timeoutMs）を必ず渡す
 */
export function describeOnWindows(name: string, timeoutMs: number, body: () => void): void {
  describe.runIf(process.platform === 'win32')(name, { timeout: timeoutMs }, body);
}
