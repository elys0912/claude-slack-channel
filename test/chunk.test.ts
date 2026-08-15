import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/chunk.js';
import { reconstructAndCheck } from './helpers/chunk-reconstruct.js';
import { mulberry32, randomText } from './helpers/random-text.js';

describe('chunkText の基本', () => {
  it('長さが limit 以下なら、そのまま 1 つのチャンクで返す', () => {
    expect(chunkText('hello', 100)).toEqual(['hello']);
  });

  it('空文字なら空の配列を返す', () => {
    expect(chunkText('', 100)).toEqual([]);
  });

  it('limit が 64 未満なら投げる', () => {
    expect(() => chunkText('x'.repeat(100), 63)).toThrow();
  });

  it('limit がちょうど 64 なら投げない', () => {
    expect(() => chunkText('x'.repeat(100), 64)).not.toThrow();
  });

  it('ただの改行より、段落の区切り（空行）で分ける', () => {
    const a = 'A'.repeat(50);
    const b = 'B'.repeat(50);
    const text = a + '\n\n' + b;
    const chunks = chunkText(text, 64);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.endsWith('\n\n')).toBe(true);
  });

  it('区切りの無い長い文字列は limit ちょうどで分け、つなぐと元に戻る', () => {
    const text = 'x'.repeat(200);
    const chunks = chunkText(text, 64);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(64);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('サロゲートペア（絵文字）の途中では分けない', () => {
    const emoji = '\u{1F600}'; // 😀 (surrogate pair)
    const text = 'a'.repeat(63) + emoji + 'b'.repeat(63);
    const chunks = chunkText(text, 64);
    for (const c of chunks) {
      // 上位サロゲート単独で終わっていないこと
      const lastCode = c.charCodeAt(c.length - 1);
      expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('段落の混ざった文でも、どのチャンクも limit 以内で、つなぐと元に戻る', () => {
    const para = 'word '.repeat(40).trim();
    const text = [para, para, para].join('\n\n');
    const chunks = chunkText(text, 80);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(80);
    }
    expect(chunks.join('')).toBe(text);
  });
});

describe('chunkText のコードブロック', () => {
  it('チャンクをまたぐコードブロックは閉じ直して言語付きで開き直し、足した分を除くと元に戻る', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i} of some codeish content here`);
    const code = lines.join('\n');
    const text = '```js\n' + code + '\n```';
    const limit = 64;
    const chunks = chunkText(text, limit);
    expect(chunks.length).toBeGreaterThan(1);
    // reconstructAndCheck は、各チャンクが limit 以内であることと、開き直しが ```js\n で始まることも確かめる
    expect(reconstructAndCheck(chunks, limit)).toBe(text);
  });

  it('最後のチャンクの閉じていないフェンスはそのままにする', () => {
    const text = 'intro\n\n```js\nconsole.log(1)';
    const chunks = chunkText(text, 1000);
    expect(chunks).toEqual([text]);
  });
});

describe('chunkText の乱数の入力（固定シード）', () => {
  it('100 ケースのどのチャンクも limit 以内に収まる（seed=42）', () => {
    const rand = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const len = 50 + Math.floor(rand() * 400);
      const limit = 64 + Math.floor(rand() * 200);
      const text = randomText(rand, len);
      const chunks = chunkText(text, limit);
      for (const c of chunks) {
        expect(c.length).toBeLessThanOrEqual(limit);
      }
    }
  });
});
