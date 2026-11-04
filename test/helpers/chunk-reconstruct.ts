// chunkText の出力から、開き直し・閉じ直しで足したフェンスを取り除いて元の文字列を復元する（chunk.test.ts・chunk-legacy.test.ts で共用）。
// 復元しながら prefix / suffix がフェンスの状態と一致することも確かめる。
// フェンスの追跡は本体（src/chunk.ts）を使わず、同じ意味のものをここで独立に持つ（本体の誤りをそのまま正にしないため）。
import { expect } from 'vitest';

/** initial の状態から content を読んだ後のフェンスの状態（開いていれば情報文字列、閉じていれば undefined） */
export function fenceStateAfter(initial: string | undefined, content: string): string | undefined {
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

/** 末尾が上位サロゲート（サロゲートペアの前半）で終わる文字列 */
export const ENDS_WITH_HIGH_SURROGATE_RE = /[\uD800-\uDBFF]$/;

/** チャンク列から、開き直し／閉じ直しを取り除いて元の文字列を復元しつつ、prefix/suffix の整合を検証する */
export function reconstructAndCheck(chunks: string[], limit: number): string {
  let open: string | undefined = undefined;
  let out = '';
  chunks.forEach((chunk, i) => {
    expect(chunk.length).toBeLessThanOrEqual(limit);
    let body = chunk;
    if (open !== undefined) {
      const prefix = '```' + open + '\n';
      expect(body.slice(0, prefix.length)).toBe(prefix);
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
      expect(body).not.toMatch(ENDS_WITH_HIGH_SURROGATE_RE);
    }
    out += body;
  });
  return out;
}
