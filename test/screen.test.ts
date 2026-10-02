import { describe, expect, it } from 'vitest';
import { choiceFingerprint, hasEmptyPrompt, keysToSelect, parseChoiceScreen, screenTail } from '../src/screen.js';

describe('hasEmptyPrompt', () => {
  it('末尾に空の入力欄があれば true', () => {
    expect(hasEmptyPrompt('Claude: done.\n\n❯ \n  ? for shortcuts\n')).toBe(true);
    expect(hasEmptyPrompt('> ')).toBe(true);
  });

  it('起動直後の入力例（Try "…"）だけの入力欄は空とみなす', () => {
    // 2026-10-03 に !screen で取れた起動直後の画面の末尾
    const screen = ['─'.repeat(20), '>\u00a0Try "how do I log an error?"', '─'.repeat(20), '  ⏵⏵ accept edits on (shift+tab to cycle)'].join('\n');
    expect(hasEmptyPrompt(screen)).toBe(true);
    expect(hasEmptyPrompt('❯ Try "write a test for screen.ts"')).toBe(true);
  });

  it('入力例に似ていても、続きを打っていれば空とみなさない', () => {
    expect(hasEmptyPrompt('> Try "a" and more')).toBe(false);
    expect(hasEmptyPrompt('> Try it')).toBe(false);
  });

  it('打ちかけ・応答中・選択画面なら false', () => {
    expect(hasEmptyPrompt('❯ git sta')).toBe(false);
    expect(hasEmptyPrompt('⠋ Thinking…')).toBe(false);
    expect(hasEmptyPrompt(' Choose\n  > One\n    Two\n')).toBe(false);
    expect(hasEmptyPrompt('')).toBe(false);
  });

  it('入力欄がずっと上（末尾 8 行より前）にあれば false', () => {
    expect(hasEmptyPrompt('❯ \n' + 'output\n'.repeat(10))).toBe(false);
  });
});

// 2026-09-30 に実際に止まった画面（Claude in Chrome の案内）
const CHROME_SCREEN = [
  '●Skill(claude-in-chrome)',
  '  ⎿  Initializing…',
  '●Getting current date and time',
  '  ⎿  $ Get-Date -Format "yyyy-MM-dd HH:mm:ss"',
  '────────────────────────────────────────────────',
  ' Claude wants to use your browser',
  '  This task could use your Chrome browser. The Claude in Chrome extension lets Claude navigate sites, click buttons,',
  '  and fill forms in your existing session.',
  '    Install extension  Opens the install page in Chrome',
  '  > Not now            Continue without browser tools',
  '    Don\'t ask again    Revisit anytime with /chrome',
  '',
].join('\n');

const NUMBERED_SCREEN = [
  ' WARNING: Loading development channels',
  '',
  ' > 1. I am using this for local development',
  '   2. Exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

const PROMPT_SCREEN = [
  '●作業完了よ。',
  '────────────────────────────────',
  '> Slackの返信ツールって使えるようにできる？',
  '────────────────────────────────',
  '  ⏵⏵ accept edits on (shift+tab to cycle)',
].join('\n');

describe('parseChoiceScreen', () => {
  it('番号無しの選択画面（Claude in Chrome）から選択肢・説明・カーソル位置・見出しを取り出す', () => {
    const choice = parseChoiceScreen(CHROME_SCREEN);
    expect(choice?.options).toEqual([
      { label: 'Install extension', description: 'Opens the install page in Chrome' },
      { label: 'Not now', description: 'Continue without browser tools' },
      { label: "Don't ask again", description: 'Revisit anytime with /chrome' },
    ]);
    expect(choice?.cursor).toBe(1);
    expect(choice?.title[0]).toBe('Claude wants to use your browser');
  });

  it('番号付きの選択画面を取り出す', () => {
    const choice = parseChoiceScreen(NUMBERED_SCREEN);
    expect(choice?.options.map((o) => o.label)).toEqual(['1. I am using this for local development', '2. Exit']);
    expect(choice?.cursor).toBe(0);
    expect(choice?.title).toEqual(['WARNING: Loading development channels']);
  });

  it('入力欄の `> ` だけでは選択画面とみなさない', () => {
    expect(parseChoiceScreen(PROMPT_SCREEN)).toBeUndefined();
  });

  it('カーソル記号 ❯ も認識する', () => {
    const screen = ['Pick one', '  ❯ Yes', '    No'].join('\n');
    expect(parseChoiceScreen(screen)?.options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });

  it('カーソル行が無ければ undefined', () => {
    expect(parseChoiceScreen('hello\nworld')).toBeUndefined();
  });
});

describe('choiceFingerprint', () => {
  it('カーソル位置が変われば別の指紋になる', () => {
    const a = parseChoiceScreen(CHROME_SCREEN);
    const b = parseChoiceScreen(CHROME_SCREEN.replace('  > Not now', '    Not now').replace('    Install extension', '  > Install extension'));
    expect(a && b && choiceFingerprint(a) !== choiceFingerprint(b)).toBe(true);
    expect(a && choiceFingerprint(a) === choiceFingerprint(parseChoiceScreen(CHROME_SCREEN)!)).toBe(true);
  });
});

describe('keysToSelect', () => {
  it.each([
    [1, 1, ['Enter']],
    [1, 2, ['Down', 'Enter']],
    [2, 0, ['Up', 'Up', 'Enter']],
  ])('cursor=%d から target=%d', (cursor, target, keys) => {
    expect(keysToSelect(cursor, target)).toEqual(keys);
  });
});

describe('screenTail', () => {
  it('空行を詰めて末尾の行だけ返す', () => {
    expect(screenTail('a\n\nb\n  \nc\n', 2)).toBe('b\nc');
  });
});
