// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
import { describe, expect, it } from 'vitest';
import { parseSwitch, unknownSwitchMessage } from '../src/env-switch.js';

describe('parseSwitch', () => {
  it.each([
    ['on', true],
    ['ON', true],
    [' true ', true],
    ['1', true],
    ['off', false],
    ['False', false],
    ['0', false],
    ['', undefined],
    ['  ', undefined],
    [undefined, undefined],
    ['yes', null],
    ['only', null],
  ] as const)('%j → %j', (raw, expected) => {
    expect(parseSwitch(raw)).toBe(expected);
  });
});

describe('unknownSwitchMessage', () => {
  it('値そのものは出さず、長さと、代わりに使う値を書く', () => {
    const text = unknownSwitchMessage('SESSION_ALLOW_ALL', ' yes ', false);
    expect(text).toBe('.env の SESSION_ALLOW_ALL の値（3 文字）は on / off のどちらでもないので off にした');
    expect(text).not.toContain('yes');
  });
});
