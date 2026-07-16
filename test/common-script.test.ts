import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const common = path.join(import.meta.dirname, '..', 'scripts', 'common.ps1');

/** common.ps1 を読み込んでから command を実行し、stdout を返す */
function ps(command: string): string {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `. '${common}'; ${command}`],
    { encoding: 'utf8', windowsHide: true }
  );
  if (r.status !== 0) throw new Error(`powershell が失敗: ${r.stderr}`);
  return r.stdout.trim();
}

// powershell.exe の起動は CI の初回だと 5 秒を超えることがある
describe.runIf(process.platform === 'win32')('scripts/common.ps1 の Read-RestartSessionId', { timeout: 30000 }, () => {
  let dir: string;
  let flag: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-flag-'));
    flag = path.join(dir, 'restart.flag');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const read = (): string => ps(`$id = Read-RestartSessionId -Path '${flag}'; if ($null -eq $id) { '<null>' } else { $id }`);

  it('ブリッジが書いた印から session_id を読む', () => {
    fs.writeFileSync(flag, JSON.stringify({ at: '2026-10-03T00:00:00.000Z', sessionId: 'c2097ecd-29b0-4cee-9f3e-a9aeace64bc3' }) + '\n');
    expect(read()).toBe('c2097ecd-29b0-4cee-9f3e-a9aeace64bc3');
  });

  it('id が無い（古い印）・UUID の形でない・JSON でない・ファイルが無いなら null（--continue にする）', () => {
    fs.writeFileSync(flag, JSON.stringify({ at: '2026-10-03T00:00:00.000Z' }));
    expect(read()).toBe('<null>');
    fs.writeFileSync(flag, JSON.stringify({ sessionId: 'x --dangerously-skip-permissions' }));
    expect(read()).toBe('<null>');
    fs.writeFileSync(flag, 'not json');
    expect(read()).toBe('<null>');
    fs.rmSync(flag);
    expect(read()).toBe('<null>');
  });

  it('start.ps1 と同じ組み立てで、--continue も 1 つの引数として配列の先頭に付く', () => {
    const out = ps(
      `$claudeArgs = @('--mcp-config', 'a b.json'); $sessionId = $null; ` +
        `$resumeArgs = @(if ($sessionId) { '--resume', $sessionId } else { '--continue' }); ` +
        `$a = $resumeArgs + $claudeArgs; "$($a.Count)|$($a -join '|')"`
    );
    expect(out).toBe('3|--continue|--mcp-config|a b.json');
  });
});
