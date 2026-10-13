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

  it('Get-ResumeArgs と Get-LaunchArgs（start.ps1 の起動の引数）: 会話の記録があるときだけ --resume <id> を先頭に付ける', () => {
    const config = path.join(dir, 'config');
    fs.mkdirSync(path.join(config, 'projects', 'C--dev'), { recursive: true });
    fs.writeFileSync(path.join(config, 'projects', 'C--dev', 'c2097ecd-29b0-4cee-9f3e-a9aeace64bc3.jsonl'), '{}\n');
    const build = (id: string) =>
      ps(
        `$resumeArgs = @(Get-ResumeArgs -SessionId '${id}' -ConfigDir '${config}'); ` +
          `$a = Get-LaunchArgs -ResumeArgs $resumeArgs -ClaudeArgs @('--mcp-config', 'a b.json'); "$($a.Count)|$($a -join '|')"`
      );

    expect(build('')).toBe('2|--mcp-config|a b.json');
    expect(build('c2097ecd-29b0-4cee-9f3e-a9aeace64bc3')).toBe('4|--resume|c2097ecd-29b0-4cee-9f3e-a9aeace64bc3|--mcp-config|a b.json');
    expect(build('794af7ae-57b1-4a74-9ef5-89328e03a33d')).toBe('2|--mcp-config|a b.json');
  });

  it('Get-LaunchArgs: 要素が 1 つでも配列のまま返す（+ が文字列の連結にならない）', () => {
    expect(ps(`$a = Get-LaunchArgs -ClaudeArgs @('--x'); $a.GetType().Name + '|' + $a.Count`)).toBe('Object[]|1');
  });

  it('Get-SessionDirName: 末尾の名前にフルパスのハッシュを足し、末尾が同じ別の状態ディレクトリと分ける。DryRun は -dryrun を付ける', () => {
    const name = (stateDir: string, dryRun = false) => ps(`Get-SessionDirName -StateDir '${stateDir}'${dryRun ? ' -DryRun' : ''}`);

    const a = name('C:\\a\\slack');
    expect(a).toMatch(/^slack-[0-9a-f]{8}$/);
    expect(name('C:\\b\\slack')).not.toBe(a);
    // 大文字小文字と末尾の区切りは問わない
    expect(name('c:\\A\\Slack\\')).toBe(a.replace(/^slack/, 'Slack'));
    expect(name('C:\\a\\slack', true)).toBe(`${a}-dryrun`);
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

describe.runIf(process.platform === 'win32')('scripts/common.ps1 の Test-PlaceholderServer', { timeout: 30000 }, () => {
  let dir: string;
  let config: string;
  const mainJs = 'C:\\repo\\dist\\src\\main.js';
  const entry = { type: 'stdio', command: 'node', args: [mainJs], env: { SLACK_CHANNEL_PLACEHOLDER: '1' } };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-json-'));
    config = path.join(dir, '.claude.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (projects: Record<string, unknown>) => fs.writeFileSync(config, JSON.stringify({ numStartups: 1, projects }));
  const test = (projectDir: string) =>
    ps(`Test-PlaceholderServer -ConfigPath '${config}' -ProjectDir '${projectDir}' -ServerName 'slackbridge' -ScriptPath '${mainJs}'`);

  it('作業フォルダーの local スコープに、同じ main.js を待つだけで起動する登録があれば true', () => {
    write({ 'C:/dev': { mcpServers: { slackbridge: entry } } });
    expect(test('C:\\dev')).toBe('True');
    // キーのドライブ文字の大文字・小文字と、末尾の区切りは問わない
    expect(test('c:\\dev\\')).toBe('True');
  });

  it('別のフォルダー・別の名前・中身が違う登録・ファイルが無い・読めないなら false（登録し直す）', () => {
    write({ 'C:/dev': { mcpServers: { slackbridge: entry } } });
    expect(test('C:\\dev\\portfolio')).toBe('False');
    write({ 'C:/dev': { mcpServers: { other: entry } } });
    expect(test('C:\\dev')).toBe('False');
    write({ 'C:/dev': { mcpServers: { slackbridge: { ...entry, args: ['-e', 'process.exit(0)'] } } } });
    expect(test('C:\\dev')).toBe('False');
    write({ 'C:/dev': { mcpServers: { slackbridge: { ...entry, env: {} } } } });
    expect(test('C:\\dev')).toBe('False');
    write({ 'C:/dev': {} });
    expect(test('C:\\dev')).toBe('False');
    fs.writeFileSync(config, 'not json');
    expect(test('C:\\dev')).toBe('False');
    fs.rmSync(config);
    expect(test('C:\\dev')).toBe('False');
  });
});

// start.ps1 の New-ClaudeArgs が起動のたびに行う、merged.json の組み立て（D-SC-04 / D-DC-02）
describe.runIf(process.platform === 'win32')('scripts/common.ps1 の Read-AllowExtra / Write-EffectiveSettings', { timeout: 30000 }, () => {
  let dir: string;
  let allowExtra: string;
  let checker: string;
  let settings: string;
  let merged: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'effective-settings-'));
    allowExtra = path.join(dir, 'allow-extra.json');
    settings = path.join(dir, 'channel-settings.json');
    merged = path.join(dir, 'out', 'channel-settings.merged.json');
    // dist/src/allow-extra-check.js の代わり。`:*` を含むものを作れないルールとして返す（ビルドせずに組み立てだけを確かめる）
    checker = path.join(dir, 'checker.cjs');
    fs.writeFileSync(
      checker,
      [
        "const fs = require('fs');",
        "const allow = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).allow;",
        "process.stdout.write(JSON.stringify({ usable: allow.filter((r) => !r.includes(':*')), rejected: allow.filter((r) => r.includes(':*')) }));",
      ].join('\n')
    );
    fs.writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Read(./**)'], deny: ['Read(.env)'], ask: ['Bash(git push:*)'] } }));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const read = (): string =>
    ps(`$r = @(Read-AllowExtra -Path '${allowExtra}' -CheckerScript '${checker}' 3>$null); "$($r.Count)|$($r -join '|')"`);

  it('Read-AllowExtra: ファイルが無ければ空。作れるものだけを返し、作れないものは警告に一覧を出す', () => {
    expect(read()).toBe('0|');
    fs.writeFileSync(allowExtra, JSON.stringify({ allow: ['Bash(git status)', 'Bash(git log:*)', 'WebFetch(domain:example.com)'] }));
    expect(read()).toBe('2|Bash(git status)|WebFetch(domain:example.com)');
    const warning = ps(
      `Read-AllowExtra -Path '${allowExtra}' -CheckerScript '${checker}' 3>&1 | ` +
        `Where-Object { $_ -is [System.Management.Automation.WarningRecord] } | ForEach-Object { $_.Message }`
    );
    expect(warning).toContain('Bash(git log:*)');
    expect(warning).not.toContain('Bash(git status)');
  });

  it('Read-AllowExtra: 確かめられない（判定の失敗・判定のコマンドが無い）ときは空', () => {
    fs.writeFileSync(allowExtra, JSON.stringify({ allow: ['Bash(git status)'] }));
    const broken = path.join(dir, 'broken.cjs');
    fs.writeFileSync(broken, "process.stdout.write(JSON.stringify({ error: 'JSON 構文が不正' })); process.exit(1);");
    expect(ps(`$r = @(Read-AllowExtra -Path '${allowExtra}' -CheckerScript '${broken}' 3>$null); "$($r.Count)"`)).toBe('0');
    expect(ps(`$r = @(Read-AllowExtra -Path '${allowExtra}' -CheckerScript '${path.join(dir, 'missing.cjs')}' 3>$null); "$($r.Count)"`)).toBe('0');
  });

  it('Write-EffectiveSettings: allow に足し、hook を入れ、deny と ask はそのまま。呼び直すとその時点の allow-extra.json を反映する', () => {
    const build = (): { permissions: { allow: string[]; deny: string[]; ask: string[] }; hooks?: unknown } => {
      ps(
        `$extra = @(@('mcp__extra') + @(Read-AllowExtra -Path '${allowExtra}' -CheckerScript '${checker}' 3>$null)); ` +
          `Write-EffectiveSettings -SettingsFile '${settings}' -OutFile '${merged}' -ExtraAllow $extra -Hooks @{ Stop = @(@{ hooks = @() }) }`
      );
      const text = fs.readFileSync(merged, 'utf8');
      expect(text.charCodeAt(0)).not.toBe(0xfeff);
      return JSON.parse(text) as { permissions: { allow: string[]; deny: string[]; ask: string[] }; hooks?: unknown };
    };

    fs.writeFileSync(allowExtra, JSON.stringify({ allow: ['Bash(git status)', 'PowerShell(npm.cmd:*)'] }));
    const first = build();
    expect(first.permissions).toEqual({ allow: ['Read(./**)', 'mcp__extra', 'Bash(git status)'], deny: ['Read(.env)'], ask: ['Bash(git push:*)'] });
    expect(first.hooks).toHaveProperty('Stop');

    // !rules で消した・♾ で足したあとに起動し直したとき
    fs.writeFileSync(allowExtra, JSON.stringify({ allow: ['Bash(pwd)'] }));
    expect(build().permissions.allow).toEqual(['Read(./**)', 'mcp__extra', 'Bash(pwd)']);
  });
});
