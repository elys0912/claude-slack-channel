// 単一インスタンス実行を保証するファイルロック。
import fs from 'node:fs';
import path from 'node:path';

export interface LockInfo {
  pid: number;
  heartbeat: number; // epoch ms
  startedAt: number;
}

export interface InstanceLockOptions {
  staleMs?: number; // 既定 30000
  intervalMs?: number; // 既定 10000
  now?: () => number;
  pid?: number;
}

const DEFAULT_STALE_MS = 30000;
const DEFAULT_INTERVAL_MS = 10000;
// heartbeat が現在時刻よりこれ以上未来なら不正な値とみなす（時計のずれを少しだけ許容する）
const FUTURE_TOLERANCE_MS = 5000;

function isLockInfo(v: unknown): v is LockInfo {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.pid === 'number' &&
    typeof o.heartbeat === 'number' &&
    typeof o.startedAt === 'number'
  );
}

export class InstanceLock {
  private readonly file: string;
  private readonly staleMs: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly pid: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private startedAt: number | undefined;

  constructor(file: string, opts: InstanceLockOptions = {}) {
    this.file = file;
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.pid = opts.pid ?? process.pid;
  }

  private readInfo(): LockInfo | undefined {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (isLockInfo(parsed)) return parsed;
      return undefined;
    } catch {
      return undefined;
    }
  }

  private writeInfo(info: LockInfo): void {
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = path.join(
      dir,
      `.${path.basename(this.file)}.tmp.${this.pid}.${Math.random().toString(36).slice(2)}`,
    );
    fs.writeFileSync(tmp, JSON.stringify(info));
    fs.renameSync(tmp, this.file);
  }

  /**
   * ロックを取る。既存のロックが次のどちらかなら上書きして取る（どちらでもなければ holder を返して諦める）:
   * - isSelf: 記録された pid が自分の pid と同じ
   * - stale: heartbeat が staleMs（既定 30 秒）より古い、または現在時刻より 5 秒を超えて未来
   * 記録された pid のプロセスが生きているかは確認しない（heartbeat の新しさだけで判断する）。
   * 読めない・形の違うロックファイルは無いものとして扱う。取れたら intervalMs ごとの heartbeat 更新を始める。
   */
  tryAcquire(): { acquired: true } | { acquired: false; holder: LockInfo } {
    const existing = this.readInfo();

    if (existing) {
      const isSelf = existing.pid === this.pid;
      // 未来の heartbeat は時計の巻き戻しや改ざんで生じる。そのままだと永久に stale にならないため
      // 不正として stale 扱いにする。
      const age = this.now() - existing.heartbeat;
      const isStale = age > this.staleMs || age < -FUTURE_TOLERANCE_MS;
      if (!isSelf && !isStale) {
        return { acquired: false, holder: existing };
      }
    }

    const startedAt = this.now();
    const info: LockInfo = { pid: this.pid, heartbeat: startedAt, startedAt };

    try {
      this.writeInfo(info);
    } catch {
      // 書き込み自体に失敗した場合は取得できなかったものとして扱う
      const reread = this.readInfo();
      return { acquired: false, holder: reread ?? info };
    }

    // 書いた直後に読み直して、自分が本当に取れたかを確認する（完全な排他は求めない）
    const reread = this.readInfo();
    if (!reread || reread.pid !== this.pid) {
      return { acquired: false, holder: reread ?? info };
    }

    this.startedAt = startedAt;
    this.startHeartbeat();
    return { acquired: true };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.timer = setInterval(() => {
      if (this.startedAt === undefined) return;
      try {
        this.writeInfo({
          pid: this.pid,
          heartbeat: this.now(),
          startedAt: this.startedAt,
        });
      } catch {
        // ハートビート更新の失敗は無視する
      }
    }, this.intervalMs);
    this.timer.unref();
  }

  private stopHeartbeat(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  release(): void {
    this.stopHeartbeat();
    try {
      const existing = this.readInfo();
      if (existing && existing.pid === this.pid) {
        fs.unlinkSync(this.file);
      }
    } catch {
      // release の失敗は呼び出し元へは投げない
    }
    this.startedAt = undefined;
  }
}
