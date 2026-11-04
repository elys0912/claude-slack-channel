// chunkText の出力が、分割前の実装（test/fixtures/chunk-legacy.ts）と一致することを固定シードで確認する。
// あわせて、出力の不変条件（content の連結 = 元の文字列、prefix/suffix がフェンス状態と一致）を検証する。
import { describe, expect, it } from 'vitest';
import { MIN_LIMIT, chunkText, splitPieces } from '../src/chunk.js';
import { chunkText as chunkTextLegacy } from './fixtures/chunk-legacy.js';
import { fenceStateAfter, reconstructAndCheck } from './helpers/chunk-reconstruct.js';
import { mulberry32, randomText } from './helpers/random-text.js';

/**
 * 乱数の入力 1 件。limit は MIN_LIMIT から extraLimit 未満を足した値、長さは limit の lengthFactor 倍未満。
 * 乱数を引く順（limit → 長さ → 本文）は固定シードの結果を変えないよう保つ。label は失敗したときに出す
 */
function randomCase(rand: () => number, index: number, opts: { extraLimit: number; lengthFactor: number }) {
  const limit = MIN_LIMIT + Math.floor(rand() * opts.extraLimit);
  const len = Math.floor(rand() * limit * opts.lengthFactor);
  const text = randomText(rand, len);
  return { text, limit, label: `case #${index} limit=${limit} text=${JSON.stringify(text)}` };
}

describe('chunkText は分割前の実装と同じ出力を返す', () => {
  it('固定シードで 2000 ケース以上、新旧の出力が一致する', () => {
    const rand = mulberry32(20260930);
    let cases = 0;
    let multiChunk = 0;
    for (let i = 0; i < 2400; i++) {
      const { text, limit, label } = randomCase(rand, i, { extraLimit: 300, lengthFactor: 6 });
      const actual = chunkText(text, limit);
      expect(actual, label).toEqual(chunkTextLegacy(text, limit));
      cases += 1;
      if (actual.length > 1) multiChunk += 1;
    }
    expect(cases).toBeGreaterThanOrEqual(2000);
    // 生成器が分割を伴うケースを十分に作れていること
    expect(multiChunk).toBeGreaterThan(cases / 2);
  });

  it('極端な入力でも一致する', () => {
    const cases: [string, number][] = [
      ['```\n' + 'a'.repeat(200), 64],
      ['```ts\n' + 'b\n'.repeat(100) + '```', 64],
      ['x'.repeat(63) + '\n```\n' + 'y'.repeat(200), 64],
      ['\u{1F600}'.repeat(100), 64],
      ['\r\n'.repeat(100), 64],
      [' '.repeat(300), 64],
      ['```' + 'p'.repeat(56) + '\n' + 'q'.repeat(300), 64],
      ['a\n\n'.repeat(100), 65],
      ['```\n```\n'.repeat(50), 64],
    ];
    for (const [text, limit] of cases) {
      expect(chunkText(text, limit)).toEqual(chunkTextLegacy(text, limit));
    }
  });
});

describe('chunkText の不変条件', () => {
  it('content の連結が元の文字列に戻り、prefix/suffix がフェンス状態と一致する', () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const { text, limit, label } = randomCase(rand, i, { extraLimit: 200, lengthFactor: 5 });
      const chunks = chunkText(text, limit);
      if (text === '') {
        expect(chunks).toEqual([]);
        continue;
      }
      expect(reconstructAndCheck(chunks, limit), label).toBe(text);
    }
  });

  it('splitPieces: content の連結が元の文字列、prefix/suffix がフェンス状態と一致、chunkText と整合', () => {
    const rand = mulberry32(99);
    for (let i = 0; i < 1000; i++) {
      const { text, limit, label } = randomCase(rand, i, { extraLimit: 200, lengthFactor: 5 });
      const pieces = splitPieces(text, limit);

      expect(pieces.map((p) => p.content).join(''), label).toBe(text);
      expect(pieces.map((p) => p.prefix + p.content + p.suffix), label).toEqual(chunkText(text, limit));

      let open: string | undefined = undefined;
      pieces.forEach((p, idx) => {
        expect(p.prefix, label).toBe(open === undefined ? '' : '```' + open + '\n');
        expect(p.prefix.length + p.content.length + p.suffix.length, label).toBeLessThanOrEqual(limit);
        const isLast = idx === pieces.length - 1;
        if (isLast) {
          expect(p.suffix, label).toBe('');
        } else {
          open = fenceStateAfter(open, p.content);
          expect(p.suffix, label).toBe(open === undefined ? '' : '\n```');
          expect(p.content.length, label).toBeGreaterThan(0);
        }
      });
    }
  });
});
