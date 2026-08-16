import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { describeOnWindows, runPowerShellCommand } from './helpers/powershell.js';

const common = path.join(import.meta.dirname, '..', 'scripts', 'common.ps1');
// 会話の記録を置く ID と、記録の無い ID（どちらも UUID の形）
const SESSION_ID = 'c2097ecd-29b0-4cee-9f3e-a9aeace64bc3';
const SESSION_ID_WITHOUT_TRANSCRIPT = '794af7ae-57b1-4a74-9ef5-89328e03a33d';

/** common.ps1 を読み込んでから command を実行し、stdout を返す */
function ps(command: string): string {
  const r = runPowerShellCommand(`. '${common}'; ${command}`);
  if (r.status !== 0) throw new Error(`powershell が失敗: ${r.stderr}`);
  return r.stdout.trim();
}

describeOnWindows('scripts/common.ps1 の Read-RestartSessionId', 30000, () => {
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

  /** Claude Code の設定フォルダーの projects 配下に、id の会話の記録を置く。設定フォルダーを返す */
  function writeTranscript(id: string): string {
    const config = path.join(dir, 'config');
    fs.mkdirSync(path.join(config, 'projects', 'C--dev'), { recursive: true });
    fs.writeFileSync(path.join(config, 'projects', 'C--dev', `${id}.jsonl`), '{}\n');
    return config;
  }

  it('ブリッジが書いた印から session_id を読む', () => {
    fs.writeFileSync(flag, JSON.stringify({ at: '2026-10-03T00:00:00.000Z', sessionId: SESSION_ID }) + '\n');
    expect(read()).toBe(SESSION_ID);
  });

  it.each([
    ['id が無い（古い印）', JSON.stringify({ at: '2026-10-03T00:00:00.000Z' })],
    ['UUID の形でない', JSON.stringify({ sessionId: 'x --dangerously-skip-permissions' })],
    ['JSON でない', 'not json'],
    ['ファイルが無い', undefined],
  ])('%s なら null（新しい会話で起動する）', (_label, content) => {
    if (content !== undefined) fs.writeFileSync(flag, content);
    expect(read()).toBe('<null>');
  });

  it('Get-ResumeArgs と Get-LaunchArgs（start.ps1 の起動の引数）: 会話の記録があるときだけ --resume <id> を先頭に付ける', () => {
    const config = writeTranscript(SESSION_ID);
    const build = (id: string) =>
      ps(
        `$resumeArgs = @(Get-ResumeArgs -SessionId '${id}' -ConfigDir '${config}'); ` +
          `$a = Get-LaunchArgs -ResumeArgs $resumeArgs -ClaudeArgs @('--mcp-config', 'a b.json'); "$($a.Count)|$($a -join '|')"`
      );

    expect(build('')).toBe('2|--mcp-config|a b.json');
    expect(build(SESSION_ID)).toBe(`4|--resume|${SESSION_ID}|--mcp-config|a b.json`);
    expect(build(SESSION_ID_WITHOUT_TRANSCRIPT)).toBe('2|--mcp-config|a b.json');
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
    const config = writeTranscript(SESSION_ID);
    const test = (id: string) => ps(`Test-SessionTranscript -SessionId '${id}' -ConfigDir '${config}'`);
    expect(test(SESSION_ID)).toBe('True');
    expect(test(SESSION_ID_WITHOUT_TRANSCRIPT)).toBe('False');
    expect(ps(`Test-SessionTranscript -SessionId 'x' -ConfigDir '${path.join(dir, 'missing')}'`)).toBe('False');
  });
});

describeOnWindows('scripts/common.ps1 の Test-PlaceholderServer', 30000, () => {
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

  // false なら登録し直す
  it.each([
    ['別のフォルダー', () => write({ 'C:/dev': { mcpServers: { slackbridge: entry } } }), 'C:\\dev\\portfolio'],
    ['別の名前', () => write({ 'C:/dev': { mcpServers: { other: entry } } }), 'C:\\dev'],
    ['起動の引数が違う', () => write({ 'C:/dev': { mcpServers: { slackbridge: { ...entry, args: ['-e', 'process.exit(0)'] } } } }), 'C:\\dev'],
    ['env が違う', () => write({ 'C:/dev': { mcpServers: { slackbridge: { ...entry, env: {} } } } }), 'C:\\dev'],
    ['登録が無い', () => write({ 'C:/dev': {} }), 'C:\\dev'],
    ['読めない', () => fs.writeFileSync(config, 'not json'), 'C:\\dev'],
    ['ファイルが無い', () => undefined, 'C:\\dev'],
  ])('%s なら false', (_label, arrange, projectDir) => {
    arrange();
    expect(test(projectDir)).toBe('False');
  });
});

// start.ps1 の New-ClaudeArgs が起動のたびに行う、merged.json の組み立て（D-SC-04 / D-DC-02）
describeOnWindows('scripts/common.ps1 の Read-AllowExtra / Write-EffectiveSettings', 30000, () => {
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

  /** 警告（3 番のストリーム）を捨てて Read-AllowExtra を呼ぶ PowerShell の式 */
  const readAllowExtraCommand = (checkerScript: string): string =>
    `Read-AllowExtra -Path '${allowExtra}' -CheckerScript '${checkerScript}' 3>$null`;

  const read = (): string => ps(`$r = @(${readAllowExtraCommand(checker)}); "$($r.Count)|$($r -join '|')"`);

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
    expect(ps(`$r = @(${readAllowExtraCommand(broken)}); "$($r.Count)"`)).toBe('0');
    expect(ps(`$r = @(${readAllowExtraCommand(path.join(dir, 'missing.cjs'))}); "$($r.Count)"`)).toBe('0');
  });

  it('Write-EffectiveSettings: allow に足し、hook を入れ、deny と ask はそのまま。呼び直すとその時点の allow-extra.json を反映する', () => {
    const build = (): { permissions: { allow: string[]; deny: string[]; ask: string[] }; hooks?: unknown } => {
      ps(
        `$extra = @(@('mcp__extra') + @(${readAllowExtraCommand(checker)})); ` +
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

describeOnWindows('scripts/common.ps1 の想定外の終了からの起動し直し', 30000, () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-restart-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // .env の AUTO_RESTART が off / false / 0 のときだけ起動し直さない（無い・コメント付きも読む）
  it.each([
    ['.env が無い', undefined, 'True'],
    ['コメント付きの off', 'BOT_TOKEN=x\nAUTO_RESTART=off # 止める\n', 'False'],
    ['引用符付きの 0', 'AUTO_RESTART="0"\n', 'False'],
    ['on', 'AUTO_RESTART=on\n', 'True'],
  ])('Test-AutoRestartEnabled: %s → %s', (_label, content, expected) => {
    const env = path.join(dir, '.env');
    if (content !== undefined) fs.writeFileSync(env, content);
    expect(ps(`Test-AutoRestartEnabled -EnvFile '${env}'`)).toBe(expected);
  });

  it('Select-RecentRestarts: 窓の中の時刻だけを配列のまま返す', () => {
    const count = (times: string): string =>
      ps(`$now = [datetime]'2026-10-27 12:00'; $r = Select-RecentRestarts -Times @(${times}) -Now $now -WindowMin 10; "$($r.Count)"`);
    expect(count('')).toBe('0');
    expect(count("[datetime]'2026-10-27 11:55'")).toBe('1');
    expect(count("[datetime]'2026-10-27 11:49', [datetime]'2026-10-27 11:51', [datetime]'2026-10-27 11:59'")).toBe('2');
  });

  it('Get-LastHookSessionId: 自分の session_tag の行で最後の UUID を返す。無ければ空', () => {
    const log = path.join(dir, 'hooks.jsonl');
    const id1 = '11111111-2222-3333-4444-555555555555';
    const id2 = '66666666-7777-8888-9999-aaaaaaaaaaaa';
    const last = (): string => ps(`Get-LastHookSessionId -HookLog '${log}' -SessionTag 'mine'`);
    expect(last()).toBe('');
    fs.writeFileSync(
      log,
      [
        JSON.stringify({ session_tag: 'mine', session_id: id1 }),
        'not json',
        JSON.stringify({ session_tag: 'other', session_id: id2 }),
        JSON.stringify({ session_tag: 'mine', session_id: 'not-a-uuid' }),
      ].join('\n') + '\n'
    );
    expect(last()).toBe(id1);
  });

  it('Write-CrashRecord: ブリッジ（crash-notice.ts）が読める形で BOM なしに書く', () => {
    const file = path.join(dir, 'crash.json');
    ps(`Write-CrashRecord -Path '${file}' -ExitCode 3 -Count 2 -Max 3 -WindowMin 10 -Resumed $true`);
    const text = fs.readFileSync(file, 'utf8');
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(JSON.parse(text)).toMatchObject({ exit_code: 3, count: 2, max: 3, window_min: 10, resumed: true });
  });

  it('Write-EffectiveSettings: StatusLine を渡せば statusLine に入れる', () => {
    const settings = path.join(dir, 'channel-settings.json');
    const merged = path.join(dir, 'merged.json');
    fs.writeFileSync(settings, JSON.stringify({ permissions: { allow: [], deny: [], ask: [] } }));
    ps(
      `Write-EffectiveSettings -SettingsFile '${settings}' -OutFile '${merged}' ` +
        `-StatusLine @{ type = 'command'; command = 'node statusline.js'; refreshInterval = 60 }`
    );
    expect(JSON.parse(fs.readFileSync(merged, 'utf8')).statusLine).toEqual({ type: 'command', command: 'node statusline.js', refreshInterval: 60 });
  });
});
