// scripts/start.ps1 の -DryRun と scripts/dialog-answer.ps1 を実際に動かす。
// 起動の本体（引数の組み立て・一時ファイルの書き出し）とダイアログへの応答は、ほかのテストでは一度も実行されないため
import fs from 'node:fs';
import path from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import { beforeEach, expect, it } from 'vitest';
import { describeOnWindows, runPowerShellFile } from './helpers/powershell.js';
import { useTempDir } from './helpers/temp-dir.js';

const scriptsDir = path.join(import.meta.dirname, '..', 'scripts');

/** process.env のキーの実際の綴り（Windows では Path のことがある）。同じ名前を別の綴りで足して二重にしないため */
function envKey(name: string): string {
  return Object.keys(process.env).find((k) => k.toUpperCase() === name) ?? name;
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv = process.env): SpawnSyncReturns<string> {
  return runPowerShellFile(path.join(scriptsDir, script), args, env);
}

describeOnWindows('scripts/start.ps1 -DryRun', 60000, () => {
  const testDir = useTempDir('start-dryrun-');
  let dir: string;
  let projectDir: string;
  let stateDir: string;
  let tempDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = testDir();
    // claude.exe の代わり（DryRun では起動しない。Find-ClaudeExe が PATH で見つけられればよい）
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude.cmd'), '@exit /b 0\r\n');
    projectDir = path.join(dir, 'project');
    fs.mkdirSync(projectDir);
    stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(stateDir, '.env'), '');
    fs.writeFileSync(path.join(stateDir, 'access.json'), '{}');
    tempDir = path.join(dir, 'temp');
    fs.mkdirSync(tempDir);

    const pathKey = envKey('PATH');
    env = { ...process.env, [pathKey]: `${bin}${path.delimiter}${process.env[pathKey] ?? ''}`, [envKey('TEMP')]: tempDir };
    delete env[envKey('SLACK_CHANNEL_STATE_DIR')];
  });

  it('起動せずにコマンドラインを表示して 0 で終わり、mcp.json は DryRun 用のフォルダーに node の絶対パスで書く', () => {
    const r = runScript('start.ps1', [projectDir, '-StateDir', stateDir, '-DryRun'], env);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('--dangerously-load-development-channels server:slackbridge');
    const sessionRoot = path.join(tempDir, 'claude-slack-channel');
    const sessionDirs = fs.readdirSync(sessionRoot);
    expect(sessionDirs).toEqual([expect.stringMatching(/^state-[0-9a-f]{8}-dryrun$/)]);
    const mcp = JSON.parse(fs.readFileSync(path.join(sessionRoot, sessionDirs[0] ?? '', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; env: Record<string, string> }>;
    };
    expect(path.isAbsolute(mcp.mcpServers.slackbridge?.command ?? '')).toBe(true);
    // 一時フォルダーは 8.3 形式の短い名前のことがあるので、実体のパスで比べる
    const passedStateDir = mcp.mcpServers.slackbridge?.env.SLACK_CHANNEL_STATE_DIR ?? '';
    expect(fs.realpathSync.native(passedStateDir)).toBe(fs.realpathSync.native(stateDir));
    // 合成した設定に、使用量の記録（statusline）と、作業中を知るための UserPromptSubmit の hook が入る
    const merged = JSON.parse(fs.readFileSync(path.join(sessionRoot, sessionDirs[0] ?? '', 'channel-settings.merged.json'), 'utf8')) as {
      statusLine?: { type: string; command: string; refreshInterval: number };
      hooks?: Record<string, unknown>;
    };
    expect(merged.statusLine?.command).toContain('statusline.js');
    expect(merged.statusLine?.refreshInterval).toBe(60);
    expect(Object.keys(merged.hooks ?? {})).toContain('UserPromptSubmit');
  });
});

describeOnWindows('scripts/dialog-answer.ps1', 60000, () => {
  const dialogTestDir = useTempDir('dialog-answer-');
  let dir: string;

  beforeEach(() => {
    dir = dialogTestDir();
  });

  it('空白を含む Pattern を 1 つの引数として受け取り、時間内にダイアログが出なければ何もせず 0 で終わってログに残す', () => {
    const log = path.join(dir, 'logs', 'dialog-answer.log');
    const r = runScript('dialog-answer.ps1', [
      '-Pattern', 'development channel', '-ChoicePattern', 'local development', '-TimeoutSec', '1', '-LogFile', log,
    ]);

    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).toContain('1 秒待っても警告ダイアログ（development channel）が出なかった');
  });
});
