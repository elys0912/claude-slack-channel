// chunkText の出力が、分割前の実装（test/fixtures/chunk-legacy.ts）と一致することを固定シードで確認する。
// あわせて、出力の不変条件（content の連結 = 元の文字列、prefix/suffix がフェンス状態と一致）を検証する。
import { describe, expect, it } from 'vitest';
import { chunkText, splitPieces } from '../src/chunk.js';
import { chunkText as chunkTextLegacy } from './fixtures/chunk-legacy.js';
import { fenceStateAfter, reconstructAndCheck } from './helpers/chunk-reconstruct.js';
import { mulberry32, randomText } from './helpers/random-text.js';

describe('chunkText は分割前の実装と同じ出力を返す', () => {
  it('固定シードで 2000 ケース以上、新旧の出力が一致する', () => {
    const rand = mulberry32(20260930);
    let cases = 0;
    let multiChunk = 0;
    for (let i = 0; i < 2400; i++) {
      const limit = 64 + Math.floor(rand() * 300);
      const len = Math.floor(rand() * limit * 6);
      const text = randomText(rand, len);
      const actual = chunkText(text, limit);
      const expected = chunkTextLegacy(text, limit);
      expect(actual, `case #${i} limit=${limit} text=${JSON.stringify(text)}`).toEqual(expected);
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
      const limit = 64 + Math.floor(rand() * 200);
      const len = Math.floor(rand() * limit * 5);
      const text = randomText(rand, len);
      const chunks = chunkText(text, limit);
      if (text === '') {
        expect(chunks).toEqual([]);
        continue;
      }
      expect(reconstructAndCheck(chunks, limit), `case #${i} limit=${limit} text=${JSON.stringify(text)}`).toBe(text);
    }
  });

  it('splitPieces: content の連結が元の文字列、prefix/suffix がフェンス状態と一致、chunkText と整合', () => {
    const rand = mulberry32(99);
    for (let i = 0; i < 1000; i++) {
      const limit = 64 + Math.floor(rand() * 200);
      const len = Math.floor(rand() * limit * 5);
      const text = randomText(rand, len);
      const pieces = splitPieces(text, limit);
      const label = `case #${i} limit=${limit} text=${JSON.stringify(text)}`;

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
