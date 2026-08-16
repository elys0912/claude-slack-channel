import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceLock, acquireWithRetry, isProcessAlive } from '../src/lock.js';
import type { LockInfo } from '../src/lock.js';
import { useTempDir } from './helpers/temp-dir.js';

// OS の pid 上限（Linux 既定 4194304、Windows は DWORD）を超えない範囲で、実在しないことが確実な値。
// isProcessAlive のテストで使う。isAlive を渡さない InstanceLock は pid の生死を見ない（常に生きている扱い）ので、
// それらのテストでは「テストの中の pid（111・222）のどれでもない、別のプロセスの pid」として使う
const DEAD_PID = 2_000_000_000;
/** テストで渡す staleMs（src/lock.ts の既定値と同じ 30 秒） */
const STALE_MS = 30000;
/** heartbeat が未来でも許す幅（src/lock.ts の FUTURE_TOLERANCE_MS と同じ 5 秒） */
const FUTURE_TOLERANCE_MS = 5000;

function readLock(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** ロックファイルを直接書く（ほかのプロセスが残したロックを模す。キーを欠いた壊れた形も書ける） */
function writeLock(file: string, info: Partial<LockInfo>): void {
  fs.writeFileSync(file, JSON.stringify(info));
}

describe('InstanceLock', () => {
  const tempDir = useTempDir('lock-test-');
  let file: string;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    file = path.join(tempDir(), 'instance.lock');
    clock = 1_000_000;
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
    // 死んだプロセスが残したロックを模す: 直接ファイルを書き、heartbeat を古くする
    writeLock(file, { pid: DEAD_PID, heartbeat: clock, startedAt: clock });
    clock += STALE_MS + 10_000;

    const lock = new InstanceLock(file, { now, pid: 222, staleMs: STALE_MS });
    const result = lock.tryAcquire();
    expect(result.acquired).toBe(true);
    lock.release();
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
    expect(readLock(file).pid).toBe(111);

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
    const info = readLock(file);
    expect(Object.keys(info).sort()).toEqual(['heartbeat', 'pid', 'startedAt']);
    expect(info).toEqual({ pid: 111, heartbeat: 1_000_000, startedAt: 1_000_000 });
    lock.release();
    // 一時ファイルも残さない
    expect(fs.readdirSync(tempDir())).toEqual([]);
  });

  it('stale 判定の境界: heartbeat からちょうど staleMs 経過では取得できず、それを超えると取得できる', () => {
    writeLock(file, { pid: DEAD_PID, heartbeat: clock, startedAt: clock });
    clock += STALE_MS;
    const lockA = new InstanceLock(file, { now, pid: 222, staleMs: STALE_MS });
    expect(lockA.tryAcquire().acquired).toBe(false);

    clock += 1;
    const lockB = new InstanceLock(file, { now, pid: 222, staleMs: STALE_MS });
    expect(lockB.tryAcquire().acquired).toBe(true);
    lockB.release();
  });

  it('heartbeat が 5 秒を超えて未来なら不正として取得でき、5 秒以内なら取得できない', () => {
    writeLock(file, { pid: DEAD_PID, heartbeat: clock + FUTURE_TOLERANCE_MS, startedAt: clock });
    const lockA = new InstanceLock(file, { now, pid: 222 });
    expect(lockA.tryAcquire().acquired).toBe(false);

    writeLock(file, { pid: DEAD_PID, heartbeat: clock + FUTURE_TOLERANCE_MS + 1, startedAt: clock });
    const lockB = new InstanceLock(file, { now, pid: 222 });
    expect(lockB.tryAcquire().acquired).toBe(true);
    lockB.release();
  });

  it('キーが欠けたファイルは壊れているものとして扱い取得できる', () => {
    writeLock(file, { pid: DEAD_PID, heartbeat: clock });
    const lock = new InstanceLock(file, { now, pid: 111 });
    expect(lock.tryAcquire().acquired).toBe(true);
    lock.release();
  });

  describe('heartbeat', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('取っている間は intervalMs ごとに heartbeat だけを書き（pid・startedAt はそのまま）、release の後は書かない', () => {
      const lock = new InstanceLock(file, { now, pid: 111, intervalMs: 1000 });
      expect(lock.tryAcquire().acquired).toBe(true);

      clock += 1500;
      vi.advanceTimersByTime(1000);
      expect(readLock(file)).toEqual({ pid: 111, heartbeat: 1_001_500, startedAt: 1_000_000 });

      clock += 1000;
      vi.advanceTimersByTime(1000);
      expect(readLock(file)).toEqual({ pid: 111, heartbeat: 1_002_500, startedAt: 1_000_000 });

      // ファイルの pid が自分のままでも、release の後は書き戻さない
      lock.release();
      writeLock(file, { pid: 111, heartbeat: 1, startedAt: 1 });
      clock += 3000;
      vi.advanceTimersByTime(3000);
      expect(readLock(file).heartbeat).toBe(1);
    });

    it('別の pid に取られていたら書き戻さず、onLost に取った側を渡して heartbeat を止める', () => {
      const onLost = vi.fn();
      const lockA = new InstanceLock(file, { now, pid: 111, intervalMs: 10, onLost });
      expect(lockA.tryAcquire().acquired).toBe(true);

      // スリープ明け: A の heartbeat が既定の staleMs より古くなり、B が取る
      clock += STALE_MS + 1000;
      const lockB = new InstanceLock(file, { now, pid: 222 });
      expect(lockB.tryAcquire().acquired).toBe(true);
      vi.advanceTimersByTime(10);

      expect(onLost).toHaveBeenCalledOnce();
      expect(onLost.mock.calls[0]?.[0]).toMatchObject({ pid: 222 });
      expect(readLock(file).pid).toBe(222);
      vi.advanceTimersByTime(100);
      expect(onLost).toHaveBeenCalledOnce();

      // A の release は B のロックを消さない
      lockA.release();
      expect(fs.existsSync(file)).toBe(true);
      lockB.release();
    });
  });
});

describe('InstanceLock の isAlive（強制終了で残ったロック）', () => {
  const tempDir = useTempDir('lock-alive-');
  let file: string;

  beforeEach(() => {
    file = path.join(tempDir(), 'instance.lock');
  });

  it('heartbeat が新しくても、持ち主が死んでいれば取る。生きていれば取らない', () => {
    const now = () => 1_000_000;
    writeLock(file, { pid: 111, heartbeat: 1_000_000, startedAt: 1_000_000 });

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
  const tempDir = useTempDir('lock-retry-');
  let file: string;

  beforeEach(() => {
    file = path.join(tempDir(), 'instance.lock');
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
