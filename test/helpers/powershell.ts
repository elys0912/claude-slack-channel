// テストから scripts/*.ps1 を powershell.exe で動かす（common-script・start-script・console-script のテストで共用）。
// -NoProfile と -ExecutionPolicy Bypass は、テストを動かす人のプロファイルや実行ポリシーで結果が変わらないようにするため。
// -NonInteractive は、スクリプトが入力を待ったときに固まらず失敗させるため
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';

const POWERSHELL_OPTIONS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

/** powershell.exe -File で script を実行する（ブリッジ・dialog-answer.ps1 と同じ渡し方） */
export function runPowerShellFile(script: string, args: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): SpawnSyncReturns<string> {
  return spawnSync('powershell.exe', [...POWERSHELL_OPTIONS, '-File', script, ...args], { encoding: 'utf8', windowsHide: true, env });
}

/** powershell.exe -Command で command を実行する */
export function runPowerShellCommand(command: string): SpawnSyncReturns<string> {
  return spawnSync('powershell.exe', [...POWERSHELL_OPTIONS, '-Command', command], { encoding: 'utf8', windowsHide: true });
}
