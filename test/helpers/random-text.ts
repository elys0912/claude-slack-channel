// chunkText の試験に使う、固定シードの乱数と乱数のテキスト（chunk.test.ts・chunk-legacy.test.ts で共用）。
// シードを固定するのは、落ちたケースを同じ入力で再現できるようにするため。

/** 固定シードの簡易 PRNG（mulberry32）。0 以上 1 未満の値を返す関数を作る */
export function mulberry32(seed: number): () => number {
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
export function randomText(rand: () => number, targetLen: number): string {
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
