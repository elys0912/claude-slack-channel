// test/helpers/chunk-reconstruct.ts の fenceStateAfter のテスト。
// chunk 系のテストの正しさはこの独立実装に頼るので、開く・閉じる・閉じないの境界をここで固定する。
import { describe, expect, it } from 'vitest';
import { fenceStateAfter } from './helpers/chunk-reconstruct.js';

describe('fenceStateAfter', () => {
  it.each([
    ['フェンスの無い行だけなら閉じたまま', undefined, 'a\nb', undefined],
    ['行頭の ``` で開き、情報文字列を返す', undefined, 'a\n```js\nb', 'js'],
    ['情報文字列の前後の空白は除く', undefined, '```js  ', 'js'],
    ['情報文字列が無ければ空文字で開く', undefined, '```', ''],
    ['開いた状態で、空白だけが続く ``` で閉じる', 'js', 'x\n```  ', undefined],
    ['開いた状態で、情報文字列付きの ``` は閉じない', 'js', '```ts', 'js'],
    ['開いた状態で、フェンスの無い行なら開いたまま', 'py', 'x', 'py'],
    ['行頭でない ``` では開かない', undefined, ' ```js\na ```', undefined],
    ['同じ content の中で開いて閉じれば閉じた状態', undefined, '```js\nx\n```', undefined],
  ])('%s', (_name, initial, content, expected) => {
    expect(fenceStateAfter(initial, content)).toBe(expected);
  });
});
