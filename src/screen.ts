// ターミナル画面のテキストから、Claude Code の選択画面（カーソル付きの選択肢）を取り出す純関数群（I/O なし）
import type { ConsoleKey } from './console.js';

/** 選択中の行の行頭記号。Windows Terminal では ❯、conhost では > で描かれる */
const CURSOR_RE = /^(\s*)[❯>›]\s+(\S.*)$/;
/** 番号付きの選択肢（`1. xxx`）。カーソル記号の有無は問わない */
const NUMBERED_RE = /^\s*(?:[❯>›]\s+)?(\d+)\.\s+(\S.*)$/;
/** 選択肢の前に表示する見出しを探す行数 */
const TITLE_LOOKBACK = 6;
/** 選択肢の上限（Slack のボタンを出しすぎないため。permission.ts の screen_pick の value は 1 桁の番号） */
const MAX_OPTIONS = 9;
/** 選択画面でないときに Slack に送る画面の末尾の行数 */
const DEFAULT_TAIL_LINES = 25;

export interface ChoiceOption {
  label: string;
  description?: string | undefined;
}

export interface ChoiceScreen {
  /** 選択肢の上にある見出し（空行・罫線を除いた数行） */
  title: string[];
  options: ChoiceOption[];
  /** 今カーソルが乗っている選択肢の位置 */
  cursor: number;
}

function isRule(line: string): boolean {
  return /^[\s─━═\-_]+$/.test(line) && line.trim() !== '';
}

/** `Install extension  Opens the install page` のように 2 つ以上の空白で区切られた説明を分ける */
function splitLabel(text: string): ChoiceOption {
  const m = /^(.*?\S)\s{2,}(\S.*)$/.exec(text.trim());
  if (!m) return { label: text.trim() };
  return { label: (m[1] ?? '').trim(), description: (m[2] ?? '').trim() };
}

/** 行の、カーソル記号を除いた本文の開始位置 */
function textColumn(line: string): number {
  const cursor = CURSOR_RE.exec(line);
  if (cursor) return line.length - (cursor[2] ?? '').length;
  return line.length - line.trimStart().length;
}

/**
 * 画面の下から最初に見つかったカーソル行を中心に、選択肢のまとまりを取り出す。
 * - 番号付き（`1. xxx`）なら、カーソル行の前後に続く番号付きの行を選択肢とする
 * - 番号無しなら、カーソル行と本文の開始位置が同じで、間に空行を挟まない前後の行を選択肢とする
 * 選択肢が 2 つ未満なら選択画面ではない（入力欄の `> ` などを誤認しないため）として undefined を返す。
 */
export function parseChoiceScreen(screen: string): ChoiceScreen | undefined {
  const lines = screen.split('\n').map((l) => l.replace(/\s+$/, ''));

  let cursorLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CURSOR_RE.test(lines[i] ?? '')) {
      cursorLine = i;
      break;
    }
  }
  if (cursorLine < 0) return undefined;

  const cursorText = lines[cursorLine] ?? '';
  const numbered = NUMBERED_RE.test(cursorText);
  const column = textColumn(cursorText);

  const belongs = (line: string | undefined): boolean => {
    if (line === undefined || line.trim() === '' || isRule(line)) return false;
    if (numbered) return NUMBERED_RE.test(line);
    return textColumn(line) === column;
  };

  let start = cursorLine;
  while (belongs(lines[start - 1])) start--;
  let end = cursorLine;
  while (belongs(lines[end + 1])) end++;

  const block = lines.slice(start, end + 1);
  if (block.length < 2 || block.length > MAX_OPTIONS) return undefined;

  const options = block.map((line) => {
    const cursor = CURSOR_RE.exec(line);
    const body = cursor ? (cursor[2] ?? '') : line.trim();
    const num = NUMBERED_RE.exec(line);
    return splitLabel(numbered && num ? `${num[1]}. ${num[2] ?? ''}` : body);
  });

  const title: string[] = [];
  for (let i = start - 1; i >= 0 && i >= start - TITLE_LOOKBACK; i--) {
    const line = lines[i] ?? '';
    if (isRule(line)) break;
    if (line.trim() !== '') title.unshift(line.trim());
  }

  return { title, options, cursor: cursorLine - start };
}

/** 画面が同じ選択画面のままかを比べるための指紋（見出し・選択肢・カーソル位置） */
export function choiceFingerprint(choice: ChoiceScreen): string {
  return JSON.stringify([choice.title, choice.options.map((o) => o.label), choice.cursor]);
}

/** カーソル位置から target を選ぶキー操作（上下に動かしてから Enter） */
export function keysToSelect(cursor: number, target: number): ConsoleKey[] {
  const keys: ConsoleKey[] = [];
  const step: ConsoleKey = target > cursor ? 'Down' : 'Up';
  for (let i = 0; i < Math.abs(target - cursor); i++) keys.push(step);
  keys.push('Enter');
  return keys;
}

/** 入力欄の行（`❯ ` / `> ` だけで、まだ何も打っていない） */
const EMPTY_PROMPT_RE = /^\s*[❯>]\s*$/;
/** 入力欄を探す画面の末尾の行数 */
const PROMPT_LOOKBACK = 8;

/**
 * 画面が「何も打っていない入力欄で待っている」状態か（選択画面ではなく、末尾の数行に空の入力欄がある）。
 * Slack から /exit や /compact を送ってよいかの確認に使う。入力欄に打ちかけの文字があれば false
 */
export function hasEmptyPrompt(screen: string): boolean {
  if (parseChoiceScreen(screen) !== undefined) return false;
  const tail = screen
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')
    .slice(-PROMPT_LOOKBACK);
  return tail.some((l) => EMPTY_PROMPT_RE.test(l));
}

/** 画面の末尾 maxLines 行（空行を詰める）。選択画面でないときに Slack に送る */
export function screenTail(screen: string, maxLines = DEFAULT_TAIL_LINES): string {
  return screen
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')
    .slice(-maxLines)
    .join('\n');
}
