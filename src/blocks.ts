// Slack の Block Kit の小さな部品（I/O なし）。複数のモジュールで同じ形を組み立てるものだけ置く。

/** Slack の button の text の上限（75）に収める */
export const BUTTON_LABEL_MAX = 70;

/** 書式なしの文だけの section */
export function plainSection(text: string): unknown {
  return { type: 'section', text: { type: 'plain_text', text } };
}

/** 書式なしの文だけの context */
export function plainContext(text: string): unknown {
  return { type: 'context', elements: [{ type: 'plain_text', text }] };
}

/** ボタン。style を省くと既定の見た目になる */
export function button(label: string, actionId: string, value: string, style?: 'primary' | 'danger'): unknown {
  return {
    type: 'button',
    text: { type: 'plain_text', text: label },
    ...(style ? { style } : {}),
    action_id: actionId,
    value
  };
}
