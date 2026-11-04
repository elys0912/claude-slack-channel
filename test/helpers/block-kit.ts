// Block Kit のブロックから、テストで確かめる部分を取り出す（permission / rule-relay / screen-relay / app のテストで共用）
// src はブロックを unknown[] で返すため、テストで見る形をここで 1 回だけ決める。

/** テストで見るブロックの項目 */
export interface BlockView {
  type: string;
  text?: { type: string; text: string };
  elements?: unknown[];
}

/** actions ブロックのボタン */
export interface ButtonView {
  action_id: string;
  value?: string;
  style?: string;
}

export function blockViewsOf(blocks: unknown[]): BlockView[] {
  return blocks as BlockView[];
}

export function blockTypesOf(blocks: unknown[]): string[] {
  return blockViewsOf(blocks).map((block) => block.type);
}

/** 最初の type のブロック。無ければ投げてテストを失敗させる */
function findBlock(blocks: unknown[], type: string): BlockView {
  const block = blockViewsOf(blocks).find((b) => b.type === type);
  if (!block) throw new Error(`${type} のブロックが無い`);

  return block;
}

/** 最初の actions ブロックのボタン。actions ブロックかボタンの列が無ければ投げる */
export function actionsOf(blocks: unknown[]): ButtonView[] {
  const { elements } = findBlock(blocks, 'actions');
  if (!elements) throw new Error('actions のブロックに elements が無い');

  return elements as ButtonView[];
}

export function actionIdsOf(blocks: unknown[]): string[] {
  return actionsOf(blocks).map((button) => button.action_id);
}

/** 最初の rich_text ブロック（preformatted で出した preview）の文字列。rich_text ブロックが無ければ投げる */
export function previewTextOf(blocks: unknown[]): string {
  const sections = findBlock(blocks, 'rich_text').elements as { elements?: { text: string }[] }[] | undefined;
  return sections?.[0]?.elements?.[0]?.text ?? '';
}
