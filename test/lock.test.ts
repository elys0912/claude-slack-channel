import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceLock, acquireWithRetry, isProcessAlive } from '../src/lock.js';

// OS の pid 上限（Linux 既定 4194304、Windows は DWORD）を超えない範囲で、実在しないことが確実な値
const DEAD_PID = 2_000_000_000;

describe('InstanceLock', () => {
  let dir: string;
  let file: string;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
    file = path.join(dir, 'instance.lock');
    clock = 1_000_000;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ロックが無ければ取得できる', () => {
    const lock = new InstanceLock(file, { now, pid: 111 });
    const result = lock.tryAcquire();
    expect(result.acquired).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    lock.release();
  });

  it('新しいロックがあれば他の pid は取得できない', () => {
    const lockA = new InstanceLock(file, { now, pid: 111 });
    expect(lockA.tryAcquire().acquired).toBe(true);

    const lockB = new InstanceLock(file, { now, pid: 222 });
    const result = lockB.tryAcquire();
    expect(result.acquired).toBe(false);
    if (!result.acquired) {
      expect(result.holder.pid).toBe(111);
    }
    lockA.release();
  });

  it('stale なら取得できる', () => {
    const lockA = new InstanceLock(file, { now, pid: 111, staleMs: 30000 });
    expect(lockA.tryAcquire().acquired).toBe(true);
    lockA.release(); // タイマーだけ止める。ファイルは自分のものなので消える

    // 死んだプロセスが残したロックを模す: 直接ファイルを書き、heartbeat を古くする
    // （pid は実在しないことが確実な値にする）
    fs.writeFileSync(
      file,
      JSON.stringify({ pid: DEAD_PID, heartbeat: clock, startedAt: clock }),
    );
    clock += 40000; // staleMs を超えて時間を進める

    const lockB = new InstanceLock(file, { now, pid: 222, staleMs: 30000 });
    const result = lockB.tryAcquire();
    expect(result.acquired).toBe(true);
    lockB.release();
  });

  it('壊れたファイルなら取得できる', () => {
    fs.writeFileSync(file, 'not valid json {{{');
    const lock = new InstanceLock(file, { now, pid: 111 });
    const result = lock.tryAcquire();
    expect(result.acquired).toBe(true);
    lock.release();
  });

  it('release は他人のロックを消さない', () => {
    const lockA = new InstanceLock(file, { now, pid: 111 });
    expect(lockA.tryAcquire().acquired).toBe(true);

    // 別 pid のインスタンスで release を試みる（保持していないので消さない）
    const lockB = new InstanceLock(file, { now, pid: 222 });
    lockB.release();

    expect(fs.existsSync(file)).toBe(true);
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(info.pid).toBe(111);

    lockA.release();
  });

  it('release の後なら取得できる', () => {
    const lockA = new InstanceLock(file, { now, pid: 111 });
    expect(lockA.tryAcquire().acquired).toBe(true);
    lockA.release();
    expect(fs.existsSync(file)).toBe(false);

    const lockB = new InstanceLock(file, { now, pid: 222 });
    expect(lockB.tryAcquire().acquired).toBe(true);
    lockB.release();
  });

  it('自分自身の pid ならロックを取得できる', () => {
    const lockA = new InstanceLock(file, { now, pid: 111 });
    expect(lockA.tryAcquire().acquired).toBe(true);

    const lockA2 = new InstanceLock(file, { now, pid: 111 });
    expect(lockA2.tryAcquire().acquired).toBe(true);
    lockA.release();
  });

  it('書き出すキーは pid / heartbeat / startedAt だけ', () => {
    const lock = new InstanceLock(file, { now, pid: 111 });
    expect(lock.tryAcquire().acquired).toBe(true);
    const info = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(info).sort()).toEqual(['heartbeat', 'pid', 'startedAt']);
    expect(info).toEqual({ pid: 111, heartbeat: 1_000_000, startedAt: 1_000_000 });
    lock.release();
    // 一時ファイルも残さない
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('heartbeat は intervalMs ごとにファイルの heartbeat だけを更新する', () => {
    vi.useFakeTimers();
    try {
      const lock = new InstanceLock(file, { now, pid: 111, intervalMs: 1000 });
      expect(lock.tryAcquire().acquired).toBe(true);

      clock += 1500;
      vi.advanceTimersByTime(1000);
      let info = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      expect(info).toEqual({ pid: 111, heartbeat: 1_001_500, startedAt: 1_000_000 });

      clock += 1000;
      vi.advanceTimersByTime(1000);
      info = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      expect(info.heartbeat).toBe(1_002_500);
      expect(info.startedAt).toBe(1_000_000);

      // release 後は更新されない
      lock.release();
      fs.writeFileSync(file, JSON.stringify({ pid: DEAD_PID, heartbeat: 1, startedAt: 1 }));
      clock += 1000;
      vi.advanceTimersByTime(1000);
      info = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      expect(info.heartbeat).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stale 判定の境界: heartbeat からちょうど staleMs 経過では取得できず、それを超えると取得できる', () => {
    fs.writeFileSync(file, JSON.stringify({ pid: DEAD_PID, heartbeat: clock, startedAt: clock }));
    clock += 30000;
    const lockA = new InstanceLock(file, { now, pid: 222, staleMs: 30000 });
    expect(lockA.tryAcquire().acquired).toBe(false);

    clock += 1;
    const lockB = new InstanceLock(file, { now, pid: 222, staleMs: 30000 });
    expect(lockB.tryAcquire().acquired).toBe(true);
    lockB.release();
  });

  it('heartbeat が 5 秒を超えて未来なら不正として取得でき、5 秒以内なら取得できない', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ pid: DEAD_PID, heartbeat: clock + 5000, startedAt: clock }),
    );
    const lockA = new InstanceLock(file, { now, pid: 222 });
    expect(lockA.tryAcquire().acquired).toBe(false);

    fs.writeFileSync(
      file,
      JSON.stringify({ pid: DEAD_PID, heartbeat: clock + 5001, startedAt: clock }),
    );
    const lockB = new InstanceLock(file, { now, pid: 222 });
    expect(lockB.tryAcquire().acquired).toBe(true);
    lockB.release();
  });

  it('キーが欠けたファイルは壊れているものとして扱い取得できる', () => {
    fs.writeFileSync(file, JSON.stringify({ pid: DEAD_PID, heartbeat: clock }));
    const lock = new InstanceLock(file, { now, pid: 111 });
    expect(lock.tryAcquire().acquired).toBe(true);
    lock.release();
  });

  it('タイマーが残らない（テストプロセスが終了できる）', () => {
    const lock = new InstanceLock(file, { now, pid: 111, intervalMs: 5 });
    expect(lock.tryAcquire().acquired).toBe(true);
    lock.release();
    // release 後は fs に触れず正常終了することだけ確認する（unref 済みのタイマーで
    // プロセスがぶら下がらないことは実運用の前提。ここでは例外が出ないことを見る）
    expect(() => lock.release()).not.toThrow();
  });
});

describe('InstanceLock の isAlive（強制終了で残ったロック）', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-alive-'));
    file = path.join(dir, 'instance.lock');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('heartbeat が新しくても、持ち主が死んでいれば取る。生きていれば取らない', () => {
    const now = () => 1_000_000;
    fs.writeFileSync(file, JSON.stringify({ pid: 111, heartbeat: 1_000_000, startedAt: 1_000_000 }));

    const alive = new InstanceLock(file, { now, pid: 222, isAlive: () => true });
    expect(alive.tryAcquire().acquired).toBe(false);

    const checked: number[] = [];
    const dead = new InstanceLock(file, { now, pid: 222, isAlive: (pid) => (checked.push(pid), false) });
    expect(dead.tryAcquire().acquired).toBe(true);
    expect(checked).toEqual([111]);
    dead.release();
  });

  it('isProcessAlive: 自分は生きていて、実在しない pid と不正な値は死んでいる', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(DEAD_PID)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});

describe('acquireWithRetry', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-retry-'));
    file = path.join(dir, 'instance.lock');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('旧インスタンスが途中で手放せば、そこで取れる', async () => {
    const old = new InstanceLock(file, { pid: 111 });
    expect(old.tryAcquire().acquired).toBe(true);
    const lock = new InstanceLock(file, { pid: 222 });
    const waits: number[] = [];
    const result = await acquireWithRetry(lock, {
      timeoutMs: 5000,
      intervalMs: 500,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 3) old.release();
      },
    });
    expect(result.acquired).toBe(true);
    expect(waits).toEqual([500, 500, 500]);
    lock.release();
  });

  it('時間内に取れなければ、最後の結果（持ち主）を返す', async () => {
    const old = new InstanceLock(file, { pid: 111 });
    expect(old.tryAcquire().acquired).toBe(true);
    const lock = new InstanceLock(file, { pid: 222 });
    let slept = 0;
    const result = await acquireWithRetry(lock, { timeoutMs: 2000, intervalMs: 500, sleep: async () => void slept++ });
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.holder.pid).toBe(111);
    expect(slept).toBe(4);
    old.release();
  });
});
