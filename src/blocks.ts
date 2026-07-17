// Slack の Block Kit の小さな部品（I/O なし）。複数のモジュールで同じ形を組み立てるものだけ置く。

/** Slack の button の text の上限（75）に収める */
export const BUTTON_LABEL_MAX = 70;

/** 書式なしの文だけの section */
export function plainSection(text: string): unknown {
  return { type: 'section', text: { type: 'plain_text', text } };
}
