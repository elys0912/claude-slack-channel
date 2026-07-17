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

  it('id が無い（古い印）・UUID の形でない・JSON でない・ファイルが無いなら null（新しい会話で起動する）', () => {
    fs.writeFileSync(flag, JSON.stringify({ at: '2026-10-03T00:00:00.000Z' }));
    expect(read()).toBe('<null>');
    fs.writeFileSync(flag, JSON.stringify({ sessionId: 'x --dangerously-skip-permissions' }));
    expect(read()).toBe('<null>');
    fs.writeFileSync(flag, 'not json');
    expect(read()).toBe('<null>');
    fs.rmSync(flag);
    expect(read()).toBe('<null>');
  });

  it('start.ps1 と同じ組み立てで、引き継がないときは引数を足さず、引き継ぐときは --resume <id> が先頭に付く', () => {
    const build = (id: string) =>
      ps(
        `$claudeArgs = @('--mcp-config', 'a b.json'); $sessionId = '${id}'; ` +
          `$resumeArgs = @(if ($sessionId) { '--resume', $sessionId }); ` +
          `$a = $resumeArgs + $claudeArgs; "$($a.Count)|$($a -join '|')"`
      );
    expect(build('')).toBe('2|--mcp-config|a b.json');
    expect(build('c2097ecd-29b0-4cee-9f3e-a9aeace64bc3')).toBe('4|--resume|c2097ecd-29b0-4cee-9f3e-a9aeace64bc3|--mcp-config|a b.json');
  });

  it('Test-SessionTranscript: projects 配下のどこかに <id>.jsonl があるときだけ true', () => {
    const config = path.join(dir, 'config');
    fs.mkdirSync(path.join(config, 'projects', 'C--dev'), { recursive: true });
    fs.writeFileSync(path.join(config, 'projects', 'C--dev', 'c2097ecd-29b0-4cee-9f3e-a9aeace64bc3.jsonl'), '{}\n');
    const test = (id: string) => ps(`Test-SessionTranscript -SessionId '${id}' -ConfigDir '${config}'`);
    expect(test('c2097ecd-29b0-4cee-9f3e-a9aeace64bc3')).toBe('True');
    expect(test('794af7ae-57b1-4a74-9ef5-89328e03a33d')).toBe('False');
    expect(ps(`Test-SessionTranscript -SessionId 'x' -ConfigDir '${path.join(dir, 'missing')}'`)).toBe('False');
  });
});
