import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/chunk.js';

// フェンス開き直し／閉じ直しで足した部分を取り除き、元の文字列に戻せるか検証する
function stripAddedFence(chunks: string[]): string {
  return chunks
    .map((c, i) => {
      let body = c;
      if (i > 0) {
        // 先頭の ```lang\n を取り除く（前のチャンクがフェンスを開いたまま終わった場合のみ付く）
        const m = /^```[^\n]*\n/.exec(body);
        // 先頭が実際に「開き直し」かどうかは前チャンクの末尾を見ないと厳密には分からないが、
        // このテストでは各ケースで意図的に組み立てるため、該当する場合のみ除去する。
        if (m && chunks[i - 1] !== undefined && /\n```$/.test(chunks[i - 1] as string)) {
          body = body.slice(m[0].length);
        }
      }
      if (i < chunks.length - 1 && /\n```$/.test(body)) {
        // 末尾の閉じ直しは、次のチャンクが開き直しで始まっている場合のみ除去する
        const next = chunks[i + 1];
        if (next !== undefined && /^```[^\n]*\n/.test(next)) {
          body = body.slice(0, -('\n```'.length));
        }
      }
      return body;
    })
    .join('');
}

describe('chunkText basics', () => {
  it('returns [text] when text.length <= limit', () => {
    expect(chunkText('hello', 100)).toEqual(['hello']);
  });

  it('returns [] for empty string', () => {
    expect(chunkText('', 100)).toEqual([]);
  });

  it('throws when limit < 64', () => {
    expect(() => chunkText('x'.repeat(100), 63)).toThrow();
  });

  it('does not throw at limit === 64', () => {
    expect(() => chunkText('x'.repeat(100), 64)).not.toThrow();
  });

  it('prefers a paragraph break over a plain newline', () => {
    const a = 'A'.repeat(50);
    const b = 'B'.repeat(50);
    const text = a + '\n\n' + b;
    const chunks = chunkText(text, 64);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.endsWith('\n\n')).toBe(true);
  });

  it('splits a long word-less string exactly at the limit', () => {
    const text = 'x'.repeat(200);
    const chunks = chunkText(text, 64);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(64);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('does not split a surrogate pair (emoji) in half', () => {
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

  it('every chunk stays within the limit for a mixed paragraph text', () => {
    const para = 'word '.repeat(40).trim();
    const text = [para, para, para].join('\n\n');
    const chunks = chunkText(text, 80);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(80);
    }
    expect(chunks.join('')).toBe(text);
  });
});

describe('chunkText code fences', () => {
  it('reopens and closes a fence split across chunks, preserving the language', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i} of some codeish content here`);
    const code = lines.join('\n');
    const text = '```js\n' + code + '\n```';
    const limit = 64;
    const chunks = chunkText(text, limit);
    expect(chunks.length).toBeGreaterThan(1);

    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(limit);
    }

    // 最初のチャンク以外で、フェンス開き直しがあるものは ```js\n で始まる
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1] as string;
      const cur = chunks[i] as string;
      if (prev.endsWith('\n```')) {
        expect(cur.startsWith('```js\n')).toBe(true);
      }
    }

    const reconstructed = stripAddedFence(chunks);
    expect(reconstructed).toBe(text);
  });

  it('leaves a trailing unclosed fence alone in the final chunk', () => {
    const text = 'intro\n\n```js\nconsole.log(1)';
    const chunks = chunkText(text, 1000);
    expect(chunks).toEqual([text]);
  });
});

describe('chunkText property-style: many random inputs stay within the limit', () => {
  // 固定シードの簡易 PRNG（mulberry32）
  function mulberry32(seed: number) {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const words = ['foo', 'bar', 'baz', 'あいう', '\n', '\n\n', ' ', '```', '```ts', '😀', 'hello', 'world'];

  function randomText(rand: () => number, len: number): string {
    let s = '';
    while (s.length < len) {
      const idx = Math.floor(rand() * words.length);
      s += words[idx];
    }
    return s;
  }

  it('keeps every chunk within the limit across many random cases (seed=42)', () => {
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
