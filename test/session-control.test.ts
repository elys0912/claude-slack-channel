import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionControl, defaultKillParent, parseTasklistName } from '../src/session-control.js';
import type { KillParentDeps } from '../src/session-control.js';
import { Logger } from '../src/log.js';
import type { ConsoleAccess, ConsoleCommand } from '../src/console.js';

const AT = { channel: 'D1', threadTs: '1.0' };
const PROMPT = 'Claude: ok\n\n❯ \n';

describe('SessionControl', () => {
  let dir: string;
  let flag: string;
  let posted: string[];
  let commands: ConsoleCommand[];
  let killed: number;
  let screen: string;

  function fakeConsole(opts: { fail?: boolean } = {}): ConsoleAccess {
    return {
      read: async () => screen,
      sendKeys: async () => undefined,
      sendCommand: async (c) => {
        if (opts.fail) throw new Error('console gone');
        commands.push(c);
      },
    };
  }

  function make(console: ConsoleAccess | undefined, exitConfirmMs = 50, exitGiveUpMs = 150): SessionControl {
    return new SessionControl({
      console,
      restartFlagFile: flag,
      bridge: { postText: async (_c, text) => ({ ts: [String(posted.push(text))] }) },
      logger: new Logger({ stderr: false }),
      killParent: () => void killed++,
      exitConfirmMs,
      exitGiveUpMs,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-'));
    flag = path.join(dir, 'restart.flag');
    posted = [];
    commands = [];
    killed = 0;
    screen = PROMPT;
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('restart: 印を置き、入力待ちなら /exit を送り、終了しなければ知らせる。印は 2 段目の時間まで残し、過ぎたら消す（D-SC-03）', async () => {
    const s = make(fakeConsole());
    await s.restart(AT, 'U1', false);
    expect(fs.existsSync(flag)).toBe(true);
    expect(commands).toEqual(['exit']);
    expect(posted).toEqual([expect.stringContaining('/exit を送った')]);

    await vi.advanceTimersByTimeAsync(50);
    expect(posted[1]).toContain('まだ終了していない');
    expect(posted[1]).toContain('このまま待てば起動し直す');
    // 遅れて終了したときに起動し直せるよう、1 段目の知らせでは印を消さない
    expect(fs.existsSync(flag)).toBe(true);

    await vi.advanceTimersByTimeAsync(99);
    expect(fs.existsSync(flag)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(posted[2]).toContain('印は消した');
    expect(fs.existsSync(flag)).toBe(false);
    s.stop();
  });

  it('restart: 1 段目の知らせの後に stop すれば、印を消さない（終了したので start.ps1 が起動し直す）', async () => {
    const s = make(fakeConsole());
    await s.restart(AT, 'U1', false);
    await vi.advanceTimersByTimeAsync(50);
    s.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(posted).toHaveLength(2);
    expect(fs.existsSync(flag)).toBe(true);
  });

  it('restart: stop すれば終了の確認を知らせない', async () => {
    const s = make(fakeConsole());
    await s.restart(AT, 'U1', false);
    s.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(posted).toHaveLength(1);
  });

  it('restart: 画面が選択画面・打ちかけなら送らず知らせる', async () => {
    const s = make(fakeConsole());
    screen = ' Choose\n  > One\n    Two\n';
    await s.restart(AT, 'U1', false);
    expect(commands).toEqual([]);
    expect(posted[0]).toContain('入力待ちでない');

    screen = '❯ git sta';
    await s.restart(AT, 'U1', false);
    expect(commands).toEqual([]);
    // 送らなかったので、後で手元で終了しても起動し直さないよう印は残さない
    expect(fs.existsSync(flag)).toBe(false);
  });

  it('restart: /exit の送信に失敗したら印を消す', async () => {
    await make(fakeConsole({ fail: true })).restart(AT, 'U1', false);
    expect(posted[0]).toContain('送れなかった');
    expect(fs.existsSync(flag)).toBe(false);
  });

  it('restart: 強制終了に失敗したら印を消す', async () => {
    const s = new SessionControl({
      console: undefined,
      restartFlagFile: flag,
      bridge: { postText: async (_c, text) => ({ ts: [String(posted.push(text))] }) },
      logger: new Logger({ stderr: false }),
      killParent: () => {
        throw new Error('EPERM');
      },
    });
    await s.restart(AT, 'U1', true);
    expect(posted.at(-1)).toContain('強制終了に失敗した');
    expect(fs.existsSync(flag)).toBe(false);
  });

  it('restart: console が無ければ force を案内する。force は console が無くても止める', async () => {
    const s = make(undefined);
    await s.restart(AT, 'U1', false);
    expect(posted[0]).toContain('!restart force');
    expect(killed).toBe(0);
    expect(fs.existsSync(flag)).toBe(false);

    await s.restart(AT, 'U1', true);
    expect(killed).toBe(1);
    expect(fs.existsSync(flag)).toBe(true);
  });

  it('restart: 印を書けなければ何も送らない', async () => {
    const s = new SessionControl({
      console: fakeConsole(),
      restartFlagFile: path.join(dir, 'no-such-dir', 'restart.flag'),
      bridge: { postText: async (_c, text) => ({ ts: [String(posted.push(text))] }) },
      logger: new Logger({ stderr: false }),
      killParent: () => void killed++,
    });
    await s.restart(AT, 'U1', true);
    expect(killed).toBe(0);
    expect(posted[0]).toContain('書けなかった');
  });

  it('compact: /compact を送る。送信に失敗しても投げずに知らせる', async () => {
    await make(fakeConsole()).compact(AT, 'U1');
    expect(commands).toEqual(['compact']);
    expect(posted[0]).toContain('/compact を送った');

    await make(fakeConsole({ fail: true })).compact(AT, 'U1');
    expect(posted[1]).toContain('送れなかった');
    expect(fs.existsSync(flag)).toBe(false);
  });

  it('clear: /clear を送る。送信に失敗しても投げずに知らせる', async () => {
    await make(fakeConsole()).clear(AT, 'U1');
    expect(commands).toEqual(['clear']);
    expect(posted[0]).toContain('/clear を送った');

    await make(fakeConsole({ fail: true })).clear(AT, 'U1');
    expect(posted[1]).toContain('送れなかった');
    expect(fs.existsSync(flag)).toBe(false);
  });
});

describe('restart.flag の中身', () => {
  it('sessionId を渡せば印に書き、無ければ書かない', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flag-content-'));
    const flag = path.join(dir, 'restart.flag');
    try {
      const make = (sessionId: (() => string | undefined) | undefined) =>
        new SessionControl({
          console: undefined,
          restartFlagFile: flag,
          bridge: { postText: async () => ({ ts: [] }) },
          logger: new Logger({ stderr: false }),
          killParent: () => undefined,
          sessionId,
        });
      await make(() => 'c2097ecd-29b0-4cee-9f3e-a9aeace64bc3').restart(AT, 'U1', true);
      expect(JSON.parse(fs.readFileSync(flag, 'utf8'))).toMatchObject({ sessionId: 'c2097ecd-29b0-4cee-9f3e-a9aeace64bc3' });

      await make(undefined).restart(AT, 'U1', true);
      expect(JSON.parse(fs.readFileSync(flag, 'utf8'))).not.toHaveProperty('sessionId');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseTasklistName（!restart force で親の名前を確かめる）', () => {
  it('tasklist の CSV から pid の行のイメージ名を読む', () => {
    const csv = '"claude.exe","4321","Console","1","250,000 K"\r\n';
    expect(parseTasklistName(csv, 4321)).toBe('claude.exe');
  });

  it('pid が違う・見つからない（INFO: の行）なら undefined', () => {
    expect(parseTasklistName('"claude.exe","4321","Console","1","1 K"\r\n', 1234)).toBeUndefined();
    expect(parseTasklistName('INFO: No tasks are running which match the specified criteria.\r\n', 1234)).toBeUndefined();
  });
});

describe('defaultKillParent（!restart force で止めてよい親か）', () => {
  const logger = new Logger({ stderr: false });

  function deps(name: string | undefined, platform: NodeJS.Platform = 'win32'): KillParentDeps & { killed: number[] } {
    const killed: number[] = [];
    return {
      ppid: 4321,
      platform,
      processName: async () => name,
      killTree: async (pid) => {
        killed.push(pid);
      },
      killProcess: (pid) => {
        killed.push(pid);
      },
      killed,
    };
  }

  it.each(['claude.exe', 'node.exe', 'Claude.EXE'])('親が Claude Code 本体（%s）なら、プロセスツリーごと止める', async (name) => {
    const d = deps(name);
    await defaultKillParent(logger, d);
    expect(d.killed).toEqual([4321]);
  });

  it.each([['powershell.exe'], ['cmd.exe'], [undefined]])('親が %s（シェル・名前不明）なら止めずに投げる', async (name) => {
    const d = deps(name);
    await expect(defaultKillParent(logger, d)).rejects.toThrow(/Claude Code ではないので止めない/);
    expect(d.killed).toEqual([]);
  });

  it('Windows 以外では名前を確かめずに親を止める', async () => {
    const d = deps(undefined, 'linux');
    await defaultKillParent(logger, d);
    expect(d.killed).toEqual([4321]);
  });
});
