// `!restart force` で親プロセス（Claude Code 本体）を止める、OS のプロセス操作。
// Windows では tasklist で親の名前を確かめてから taskkill でプロセスツリーごと止める。
// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from './log.js';
import { systemExe } from './system-exe.js';

/** taskkill / tasklist を待つ上限 */
const KILL_TIMEOUT_MS = 10000;
/** !restart force でプロセスツリーごと止めてよい親（Claude Code 本体）。シェル等が親なら巻き込まないよう止めない */
const KILLABLE_PARENTS = new Set(['claude.exe', 'node.exe']);

const execFileAsync = promisify(execFile);

/** defaultKillParent が使うプロセスまわりの操作（テストで差し替える） */
export interface KillParentDeps {
  ppid: number;
  platform: NodeJS.Platform;
  /** pid のイメージ名（claude.exe など）。分からなければ undefined */
  processName: (pid: number) => Promise<string | undefined>;
  /** Windows: pid のプロセスを子ごと止める */
  killTree: (pid: number) => Promise<void>;
  /** Windows 以外: pid のプロセスを止める */
  killProcess: (pid: number) => void;
}

function defaultKillDeps(): KillParentDeps {
  return {
    ppid: process.ppid,
    platform: process.platform,
    processName,
    killTree,
    killProcess: (pid) => process.kill(pid),
  };
}

/**
 * 親プロセス（claude.exe）を止める。Windows では taskkill /T /F で子プロセス（MCP サーバー・Bash の子など）もまとめて止める
 * （process.kill は TerminateProcess なので子が孤児として残る）。このブリッジ自身も子なので、成功すればここで終わる。
 * 親が Claude Code 本体（KILLABLE_PARENTS）でなければ、シェルなどを巻き込まないよう止めずに投げる
 */
export async function defaultKillParent(logger: Logger, deps: KillParentDeps = defaultKillDeps()): Promise<void> {
  const { ppid } = deps;
  if (deps.platform !== 'win32') {
    deps.killProcess(ppid);
    return;
  }
  const name = await deps.processName(ppid);
  logger.info(`!restart force: 親 pid=${ppid} name=${name ?? '不明'}`);
  if (name === undefined || !KILLABLE_PARENTS.has(name.toLowerCase())) {
    throw new Error(`親プロセス（pid=${ppid} ${name ?? '名前不明'}）が Claude Code ではないので止めない`);
  }
  await deps.killTree(ppid);
}

async function killTree(pid: number): Promise<void> {
  await execFileAsync(systemExe('taskkill.exe'), ['/T', '/F', '/PID', String(pid)], { timeout: KILL_TIMEOUT_MS, windowsHide: true });
}

/** tasklist の CSV（"claude.exe","1234",...）から、pid のイメージ名を読む。見つからなければ undefined */
export function parseTasklistName(csv: string, pid: number): string | undefined {
  for (const line of csv.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m && Number(m[2]) === pid) return m[1];
  }
  return undefined;
}

async function processName(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(systemExe('tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      timeout: KILL_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseTasklistName(stdout, pid);
  } catch {
    return undefined;
  }
}
