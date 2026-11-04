// 有効期限付きの Map（I/O なし）。ボタンで答える提案・画面の控えのように、一度だけ取り出すものを期限付きで持つ。

/** 入れてから ttlMs を過ぎたものは取り出せない Map（時刻注入でテスト可能） */
export class ExpiringMap<V> {
  private readonly store = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number
  ) {}

  add(key: string, value: V): void {
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  /** 取り出して消す（同じものに二度答えさせない）。期限切れなら消したうえで undefined */
  take(key: string): V | undefined {
    const entry = this.store.get(key);
    this.store.delete(key);
    if (!entry || this.now() > entry.expiresAt) return undefined;
    return entry.value;
  }

  /** 期限切れのものを消す */
  prune(): void {
    const t = this.now();
    for (const [key, entry] of this.store) {
      if (t > entry.expiresAt) this.store.delete(key);
    }
  }
}
