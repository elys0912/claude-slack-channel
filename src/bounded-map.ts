// 大きさに上限のある Map（I/O なし）。
// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。

/** 古いものから忘れる、大きさに上限のある Map。set したキーは一番新しいものになる */
export class BoundedMap<V> {
  private readonly store = new Map<string, V>();

  constructor(private readonly capacity: number) {}

  get(key: string): V | undefined {
    return this.store.get(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  set(key: string, value: V): void {
    this.store.delete(key);
    this.store.set(key, value);
    if (this.store.size > this.capacity) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
  }

  get size(): number {
    return this.store.size;
  }
}
