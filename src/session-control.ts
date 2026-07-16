// Slack からの `!restart` / `!compact` / `!clear`。Claude Code にスラッシュコマンドを送る手段は channel プロトコルに無いので、
// ターミナルの入力欄に固定のコマンド（/exit・/compact・/clear）を打ち込む。自由な文字入力は受け付けない。
// 再起動は、状態ディレクトリに restart.flag を置いてから /exit を送り、start.ps1 がフラグを見て起動し直す。
// 印には今の会話の session_id（hook の記録から分かれば）を書き、start.ps1 は --resume <id> で同じ会話を開く
// （--continue はフォルダーで最新の会話を開くので、同じフォルダーの VS Code などの会話を開いてしまう）。
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConsoleAccess, ConsoleCommand } from './console.js';
import type { Logger } from './log.js';
import { errMessage } from './errors.js';
import { hasEmptyPrompt } from './screen.js';
import type { ThreadRef } from './types.js';

/** /exit を送ってから、まだ終了していないことを知らせるまでの時間 */
export const EXIT_CONFIRM_MS = 20000;
/** taskkill / tasklist を待つ上限 */
const KILL_TIMEOUT_MS = 10000;
/** !restart force でプロセスツリーごと止めてよい親（Claude Code 本体）。シェル等が親なら巻き込まないよう止めない */
const KILLABLE_PARENTS = new Set(['claude.exe', 'node.exe']);

/** 状態ディレクトリに置く再起動の印（scripts/start.ps1 の $RestartFlagName と同じ名前にすること） */
export const RESTART_FLAG_FILE = 'restart.flag';

export interface SessionSlack {
  postText(channel: string, text: string, threadTs?: string): Promise<{ ts: string[] }>;
}

export interface SessionControlOptions {
  /** ターミナルを操作する手段。無ければ !restart（force 以外）・!compact・!clear は使えない */
  console: ConsoleAccess | undefined;
  /** start.ps1 が起動し直す印として見るファイル */
  restartFlagFile: string;
  slack: SessionSlack;
  logger: Logger;
  /** 親プロセス（claude.exe）を止める（`!restart force`）。省略時は defaultKillParent */
  killParent?: ((logger: Logger) => void | Promise<void>) | undefined;
  /** 今の会話の session_id（hook の記録から分かったもの）。印に書く。分からなければ start.ps1 は --continue で起動し直す */
  sessionId?: (() => string | undefined) | undefined;
  /** /exit の後に終了を確かめるまでの時間（テスト用） */
  exitConfirmMs?: number | undefined;
}

export class SessionControl {
  private readonly opts: SessionControlOptions;
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: SessionControlOptions) {
    this.opts = opts;
  }

  /**
   * 再起動する。restart.flag を置いて /exit を送る（force なら claude.exe を止める）。
   * Claude Code が終わればこの MCP サーバーも終わり、start.ps1 がフラグを見て起動し直す。投げない。
   * 印は終了より前に置く必要があるので先に書き、/exit を送れなかった・強制終了に失敗したときは消す
   * （残すと、後で手元で終了したときに start.ps1 が勝手に起動し直す）
   */
  async restart(at: ThreadRef, byUserId: string, force: boolean): Promise<void> {
    const { logger } = this.opts;
    try {
      this.writeFlag();
    } catch (e) {
      await this.say(at, `⚠️ 再起動の印（restart.flag）を書けなかった: ${errMessage(e)}`);
      return;
    }

    if (force) {
      logger.warn(`!restart force by=${byUserId}: claude.exe を止める`);
      await this.say(at, '🔁 Claude Code を強制終了して起動し直す（会話は引き継ぐ）');
      try {
        await (this.opts.killParent ?? defaultKillParent)(logger);
      } catch (e) {
        this.removeFlag();
        await this.say(at, `⚠️ 強制終了に失敗した: ${errMessage(e)}`);
      }
      return;
    }

    const sent = await this.sendCommand(at, 'exit');
    if (!sent) {
      this.removeFlag();
      return;
    }
    logger.info(`!restart by=${byUserId}: /exit を送った`);
    await this.say(at, '🔁 /exit を送った。終了したら start.ps1 が会話を引き継いで起動し直す（開始の知らせが来るまで待つこと）');
    this.scheduleExitCheck(at);
  }

  /** /compact を送る。投げない */
  async compact(at: ThreadRef, byUserId: string): Promise<void> {
    const sent = await this.sendCommand(at, 'compact');
    if (!sent) return;
    this.opts.logger.info(`!compact by=${byUserId}: /compact を送った`);
    await this.say(at, '🧹 /compact を送った。終わると「会話を圧縮した」の知らせが来る');
  }

  /** /clear を送る（会話を捨てて新しい会話にする）。投げない */
  async clear(at: ThreadRef, byUserId: string): Promise<void> {
    const sent = await this.sendCommand(at, 'clear');
    if (!sent) return;
    this.opts.logger.info(`!clear by=${byUserId}: /clear を送った`);
    await this.say(at, '🧹 /clear を送った。終わると「会話をクリアした」の知らせが来る');
  }

  stop(): void {
    this.clearExitCheck();
  }

  /** /exit の後の「まだ終了していない」の確認を取り消す */
  private clearExitCheck(): void {
    if (this.confirmTimer !== undefined) clearTimeout(this.confirmTimer);
    this.confirmTimer = undefined;
  }

  /** 画面が空の入力欄で待っているときだけコマンドを送る。送れたら true */
  private async sendCommand(at: ThreadRef, command: ConsoleCommand): Promise<boolean> {
    const console = this.opts.console;
    if (!console) {
      await this.say(at, `⚠️ このブリッジからはターミナルを操作できないので /${command} は送れない（!restart force なら強制終了できる）`);
      return false;
    }
    try {
      const screen = await console.read();
      if (!hasEmptyPrompt(screen)) {
        await this.say(at, `⚠️ ターミナルが入力待ちでない（応答中・選択画面・打ちかけの文字がある）ので /${command} は送らなかった。!screen で確認すること`);
        return false;
      }
      await console.sendCommand(command);
      return true;
    } catch (e) {
      this.opts.logger.warn(`/${command} の送信に失敗`, e);
      await this.say(at, `⚠️ /${command} を送れなかった: ${errMessage(e)}`);
      return false;
    }
  }

  private scheduleExitCheck(at: ThreadRef): void {
    this.clearExitCheck();
    // このプロセスがまだ動いていれば、Claude Code は終了していない
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = undefined;
      void this.say(at, '⚠️ /exit を送ったが、まだ終了していない。!screen で画面を確認するか、!restart force で強制終了すること');
    }, this.opts.exitConfirmMs ?? EXIT_CONFIRM_MS);
    this.confirmTimer.unref?.();
  }

  /** 再起動の印を消す。消せなくても投げない（ログに残す） */
  private removeFlag(): void {
    try {
      fs.rmSync(this.opts.restartFlagFile, { force: true });
    } catch (e) {
      this.opts.logger.warn('再起動の印（restart.flag）を消せなかった', e);
    }
  }

  private writeFlag(): void {
    const sessionId = this.opts.sessionId?.();
    fs.writeFileSync(this.opts.restartFlagFile, JSON.stringify({ at: new Date().toISOString(), sessionId }) + '\n');
  }

  private async say(at: ThreadRef, text: string): Promise<void> {
    try {
      await this.opts.slack.postText(at.channel, text, at.threadTs);
    } catch (e) {
      this.opts.logger.warn('再起動・圧縮・クリアの知らせの投稿に失敗', e);
    }
  }
}

const execFileAsync = promisify(execFile);

/**
 * 親プロセス（claude.exe）を止める。Windows では taskkill /T /F で子プロセス（MCP サーバー・Bash の子など）もまとめて止める
 * （process.kill は TerminateProcess なので子が孤児として残る）。このブリッジ自身も子なので、成功すればここで終わる。
 * 親が Claude Code 本体（KILLABLE_PARENTS）でなければ、シェルなどを巻き込まないよう止めずに投げる
 */
export async function defaultKillParent(logger: Logger): Promise<void> {
  const ppid = process.ppid;
  if (process.platform !== 'win32') {
    process.kill(ppid);
    return;
  }
  const name = await processName(ppid);
  logger.info(`!restart force: 親 pid=${ppid} name=${name ?? '不明'}`);
  if (name === undefined || !KILLABLE_PARENTS.has(name.toLowerCase())) {
    throw new Error(`親プロセス（pid=${ppid} ${name ?? '名前不明'}）が Claude Code ではないので止めない`);
  }
  await execFileAsync('taskkill.exe', ['/T', '/F', '/PID', String(ppid)], { timeout: KILL_TIMEOUT_MS, windowsHide: true });
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
    const { stdout } = await execFileAsync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      timeout: KILL_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseTasklistName(stdout, pid);
  } catch {
    return undefined;
  }
}
