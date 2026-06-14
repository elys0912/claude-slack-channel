// 長文を Slack のメッセージ文字数制限に合わせて分割する純関数（I/O なし）

const CLOSE_FENCE = '\n```';

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

// コードフェンス（行頭の ```lang）を content 全体について追跡し、
// initial（content の直前までの状態）から見た最終状態を返す。
// 戻り値が string なら「フェンスが開いたまま」で、その値が言語名（無指定なら ''）。
// undefined なら「フェンスの外」。
function fenceStateAfter(initial: string | undefined, content: string): string | undefined {
  let state = initial;
  let idx = 0;
  while (idx <= content.length) {
    const nlIdx = content.indexOf('\n', idx);
    const lineEnd = nlIdx === -1 ? content.length : nlIdx;
    const line = content.slice(idx, lineEnd);
    if (line.startsWith('```')) {
      const rest = line.slice(3);
      if (state === undefined) {
        state = rest.trim();
      } else if (rest.trim() === '') {
        state = undefined;
      }
      // フェンス内で ```lang のような行が来ても、閉じマーカーでなければ内容として無視
    }
    if (nlIdx === -1) break;
    idx = nlIdx + 1;
  }
  return state;
}

/**
 * text を limit 文字以内のチャンクに分割する。
 * - コードフェンスをまたいで分割する場合、閉じ直し／開き直しを自動で挿入する。
 * - 段落区切り(\n\n) > 改行(\n) > 空白の優先順で、後ろ半分の範囲だけを探して区切る。
 * - サロゲートペアの途中では切らない。
 */
export function chunkText(text: string, limit: number): string[] {
  if (limit < 64) {
    throw new Error(`chunkText: limit must be >= 64 (got ${limit})`);
  }
  if (text === '') return [];
  if (text.length <= limit) return [text];

  const result: string[] = [];
  let s = text;
  let fenceLangOpen: string | undefined = undefined;

  while (s.length > 0) {
    const prefix = fenceLangOpen !== undefined ? '```' + fenceLangOpen + '\n' : '';

    if (prefix.length + s.length <= limit) {
      result.push(prefix + s);
      s = '';
      break;
    }

    const budget = Math.max(1, limit - prefix.length);

    const suffixLenAt = (cut: number): number =>
      fenceStateAfter(fenceLangOpen, s.slice(0, cut)) !== undefined ? CLOSE_FENCE.length : 0;

    // 内容量+閉じ直し分が budget に収まる最大の cut を求める
    let maxFeasibleCut = Math.min(budget, s.length);
    for (let guard = 0; guard < 64; guard++) {
      const suf = suffixLenAt(maxFeasibleCut);
      if (maxFeasibleCut + suf <= budget) break;
      const next = budget - suf;
      maxFeasibleCut = next < 0 ? 0 : next;
      if (maxFeasibleCut <= 0) {
        maxFeasibleCut = 1;
        break;
      }
    }
    if (maxFeasibleCut <= 0) maxFeasibleCut = 1;
    if (maxFeasibleCut > s.length) maxFeasibleCut = s.length;

    // 区切り探索は後ろ半分だけ
    const searchStart = Math.floor(maxFeasibleCut / 2);
    const segment = s.slice(searchStart, maxFeasibleCut);

    let cut: number;
    const paraIdx = segment.lastIndexOf('\n\n');
    if (paraIdx !== -1) {
      cut = searchStart + paraIdx + 2;
    } else {
      const nlIdx = segment.lastIndexOf('\n');
      if (nlIdx !== -1) {
        cut = searchStart + nlIdx + 1;
      } else {
        const spIdx = segment.lastIndexOf(' ');
        if (spIdx !== -1) {
          cut = searchStart + spIdx + 1;
        } else {
          cut = maxFeasibleCut;
        }
      }
    }
    if (cut <= 0) cut = maxFeasibleCut;

    // サロゲートペアの途中では切らない
    while (cut > 0 && isHighSurrogate(s.charCodeAt(cut - 1))) {
      cut -= 1;
    }
    if (cut <= 0) cut = 1;

    let stateAtCut = fenceStateAfter(fenceLangOpen, s.slice(0, cut));
    let suffix = stateAtCut !== undefined ? CLOSE_FENCE : '';
    let chunkStr = prefix + s.slice(0, cut) + suffix;

    // 念のための安全弁：万一 limit を超えていたら詰める
    while (chunkStr.length > limit && cut > 1) {
      cut -= 1;
      while (cut > 0 && isHighSurrogate(s.charCodeAt(cut - 1))) {
        cut -= 1;
      }
      stateAtCut = fenceStateAfter(fenceLangOpen, s.slice(0, cut));
      suffix = stateAtCut !== undefined ? CLOSE_FENCE : '';
      chunkStr = prefix + s.slice(0, cut) + suffix;
    }

    result.push(chunkStr);
    fenceLangOpen = stateAtCut;
    s = s.slice(cut);
  }

  return result;
}
