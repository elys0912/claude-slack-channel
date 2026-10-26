// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
import { describe, expect, it } from 'vitest';
import { BoundedMap } from '../src/bounded-map.js';

describe('BoundedMap', () => {
  it('上限を超えたら一番古いものを忘れる', () => {
    const m = new BoundedMap<number>(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    expect([m.has('a'), m.get('b'), m.get('c'), m.size]).toEqual([false, 2, 3, 2]);
  });

  it('set し直したキーは一番新しいものになり、残る', () => {
    const m = new BoundedMap<number>(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('a', 10);
    m.set('c', 3);
    expect([m.get('a'), m.has('b'), m.get('c')]).toEqual([10, false, 3]);
  });
});
