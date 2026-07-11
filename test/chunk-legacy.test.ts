// chunkText の出力が、分割前の実装（test/fixtures/chunk-legacy.ts）と一致することを固定シードで確認する。
// あわせて、出力の不変条件（content の連結 = 元の文字列、prefix/suffix がフェンス状態と一致）を検証する。
import { describe, expect, it } from 'vitest';
import { chunkText, splitPieces } from '../src/chunk.js';
import { chunkText as chunkTextLegacy } from './fixtures/chunk-legacy.js';

// 固定シードの簡易 PRNG（mulberry32）
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}

const WORDS = ['foo', 'bar', 'baz', 'あいう', 'hello', 'world', 'x', 'longer_token_here'];
const SURROGATES = ['\u{1F600}', '\u{1F468}\u{200D}\u{1F469}', '\u{1D11E}', '𠮷'];
// 情報文字列は limit-8 以下に収める（limit は 64 以上なので 10 文字まで）
const INFO_STRINGS = ['', 'ts', 'js', 'python', 'sh ', ' text', 'a b', 'md'];
const NEWLINES = ['\n', '\n', '\n\n', '\r\n', '\r\n\r\n'];

/** 行頭のフェンス、行中の ```、空白、サロゲートペアなどを混ぜたテキストを作る */
function randomText(rand: () => number, targetLen: number): string {
  let s = '';
  let atLineStart = true;
  while (s.length < targetLen) {
    const r = rand();
    if (r < 0.1) {
      // 行頭のフェンス（開閉どちらにもなり得る）
      if (!atLineStart) {
        s += pick(rand, NEWLINES);
      }
      s += '```' + pick(rand, INFO_STRINGS) + pick(rand, NEWLINES);
      atLineStart = true;
    } else if (r < 0.15) {
      // 行中の ```（フェンスとしては無効）
      s += ' ```' + pick(rand, INFO_STRINGS);
      atLineStart = false;
    } else if (r < 0.25) {
      s += pick(rand, NEWLINES);
      atLineStart = true;
    } else if (r < 0.35) {
      s += pick(rand, SURROGATES);
      atLineStart = false;
    } else if (r < 0.5) {
      s += ' ';
      atLineStart = false;
    } else if (r < 0.55) {
      // 空白だけの行やインデント
      s += '   ';
      atLineStart = false;
    } else {
      s += pick(rand, WORDS);
      atLineStart = false;
    }
  }
  return s;
}

// --- 不変条件チェック用（レガシーと同じ意味のフェンス追跡を、テスト側で独立に持つ） ---

function fenceStateAfter(initial: string | undefined, content: string): string | undefined {
  let state = initial;
  for (const line of content.split('\n')) {
    if (line.startsWith('```')) {
      const rest = line.slice(3);
      if (state === undefined) state = rest.trim();
      else if (rest.trim() === '') state = undefined;
    }
  }
  return state;
}

/** チャンク列から、開き直し／閉じ直しを取り除いて元の文字列を復元しつつ、prefix/suffix の整合を検証する */
function reconstruct(chunks: string[], limit: number): string {
  let open: string | undefined = undefined;
  let out = '';
  chunks.forEach((chunk, i) => {
    expect(chunk.length).toBeLessThanOrEqual(limit);
    let body = chunk;
    if (open !== undefined) {
      const prefix = '```' + open + '\n';
      expect(body.startsWith(prefix)).toBe(true);
      body = body.slice(prefix.length);
    }
    const isLast = i === chunks.length - 1;
    if (!isLast) {
      // 末尾に閉じ直しが付くのは、content の後でフェンスが開いているときだけ
      const withoutSuffix = body.endsWith('\n```') ? body.slice(0, -4) : body;
      const stateWithout = fenceStateAfter(open, withoutSuffix);
      if (body.endsWith('\n```') && stateWithout !== undefined) {
        body = withoutSuffix;
        open = stateWithout;
      } else {
        open = fenceStateAfter(open, body);
        expect(open).toBeUndefined();
      }
      expect(body.length).toBeGreaterThan(0);
      // サロゲートペアの途中で終わらない
      const last = body.charCodeAt(body.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    out += body;
  });
  return out;
}

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
      expect(reconstruct(chunks, limit), `case #${i} limit=${limit} text=${JSON.stringify(text)}`).toBe(text);
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
