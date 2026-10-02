import { describe, expect, it } from 'vitest';
import { clip, newToken, stripBom } from '../src/text.js';
import { TOKEN_ID_RE } from '../src/permission.js';

describe('stripBom', () => {
  it('先頭の BOM だけを取り除く', () => {
    expect(stripBom('﻿{}')).toBe('{}');
    expect(stripBom('{}')).toBe('{}');
    expect(stripBom('a﻿b')).toBe('a﻿b');
  });
});

describe('clip', () => {
  it('max 以内ならそのまま、超えたら末尾を … にして max に収める', () => {
    expect(clip('abc', 3)).toBe('abc');
    expect(clip('abcd', 3)).toBe('ab…');
    expect(clip('abcd', 3)).toHaveLength(3);
  });

  it('サロゲートペアの途中では切らない', () => {
    expect(clip('a😀b', 3)).toBe('a…');
    expect(clip('a😀😀', 4)).toBe('a😀…');
  });
});

describe('newToken', () => {
  it('permission.ts の TOKEN_ID_RE に合う 8 文字を毎回違う値で返す', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newToken()));
    for (const t of tokens) expect(t).toMatch(TOKEN_ID_RE);
    expect(tokens.size).toBeGreaterThan(45);
  });
});
