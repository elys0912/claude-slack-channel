// 長文を Slack のメッセージ文字数制限に合わせて分割する純関数（I/O なし）

const CLOSE_FENCE = '\n```';
/** limit の下限。フェンスの開き直し・閉じ直しを入れても本文が残るだけの余裕 */
const MIN_LIMIT = 64;
/** maxFeasibleCut で cut を詰め直す回数の上限（通常は 1〜2 回で収束する） */
const MAX_CUT_ADJUSTMENTS = 64;
/** 区切り位置を探す範囲（チャンクの後ろ側の何分の 1 か） */
const BREAK_SEARCH_FRACTION = 2;

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

/** 開いたままのフェンスを次のチャンクで開き直すための接頭辞 */
function openFencePrefix(fenceLangOpen: string | undefined): string {
  return fenceLangOpen !== undefined ? '```' + fenceLangOpen + '\n' : '';
}

/** cut の位置で切ったときに必要な閉じ直しの長さ（フェンスが開いたままなら CLOSE_FENCE 分） */
function closeFenceLenAt(s: string, cut: number, fenceLangOpen: string | undefined): number {
  return fenceStateAfter(fenceLangOpen, s.slice(0, cut)) !== undefined ? CLOSE_FENCE.length : 0;
}

/** 内容量 + 閉じ直し分が budget に収まる最大の cut を求める（1 以上 s.length 以下） */
function maxFeasibleCut(s: string, budget: number, fenceLangOpen: string | undefined): number {
  let cut = Math.min(budget, s.length);
  for (let guard = 0; guard < MAX_CUT_ADJUSTMENTS; guard++) {
    const suf = closeFenceLenAt(s, cut, fenceLangOpen);
    if (cut + suf <= budget) break;
    const next = budget - suf;
    cut = next < 0 ? 0 : next;
    if (cut <= 0) {
      cut = 1;
      break;
    }
  }
  if (cut <= 0) cut = 1;
  if (cut > s.length) cut = s.length;
  return cut;
}

/** 段落区切り(\n\n) > 改行(\n) > 空白の優先順で、後ろ半分の範囲だけを探して区切り位置を返す */
function findBreak(s: string, maxCut: number): number {
  const searchStart = Math.floor(maxCut / BREAK_SEARCH_FRACTION);
  const segment = s.slice(searchStart, maxCut);

  let cut = maxCut;
  for (const separator of ['\n\n', '\n', ' ']) {
    const idx = segment.lastIndexOf(separator);
    if (idx !== -1) {
      // 区切りの直後で切る（区切りは前のチャンクに残す）
      cut = searchStart + idx + separator.length;
      break;
    }
  }
  return cut <= 0 ? maxCut : cut;
}

/** サロゲートペアの途中で切らないよう、上位サロゲートの直後なら手前へ戻す（0 まで戻り得る） */
function backOffSurrogate(s: string, cut: number): number {
  while (cut > 0 && isHighSurrogate(s.charCodeAt(cut - 1))) {
    cut -= 1;
  }
  return cut;
}

export interface Piece {
  /** 前のチャンクから続くフェンスの開き直し（無ければ ''） */
  prefix: string;
  /** 元の文字列の一部（連結すると元に戻る） */
  content: string;
  /** フェンスが開いたまま終わるときの閉じ直し（無ければ ''） */
  suffix: string;
}

/** 念のための安全弁：prefix + content + suffix が limit を超えていたら cut を詰める */
function shrinkToLimit(
  s: string,
  cut: number,
  prefix: string,
  fenceLangOpen: string | undefined,
  limit: number
): { piece: Piece; cut: number; state: string | undefined } {
  const build = (at: number): { piece: Piece; state: string | undefined } => {
    const state = fenceStateAfter(fenceLangOpen, s.slice(0, at));
    const suffix = state !== undefined ? CLOSE_FENCE : '';
    return { piece: { prefix, content: s.slice(0, at), suffix }, state };
  };

  let built = build(cut);
  while (built.piece.prefix.length + built.piece.content.length + built.piece.suffix.length > limit && cut > 1) {
    cut = backOffSurrogate(s, cut - 1);
    built = build(cut);
  }
  return { piece: built.piece, cut, state: built.state };
}

/**
 * text を limit 文字以内の Piece に分割する。chunkText の実体。
 * 各 Piece の content を連結すると text に戻る。
 */
export function splitPieces(text: string, limit: number): Piece[] {
  if (limit < MIN_LIMIT) {
    throw new Error(`chunkText: limit must be >= ${MIN_LIMIT} (got ${limit})`);
  }
  if (text === '') return [];
  if (text.length <= limit) return [{ prefix: '', content: text, suffix: '' }];

  const result: Piece[] = [];
  let s = text;
  let fenceLangOpen: string | undefined = undefined;

  while (s.length > 0) {
    const prefix = openFencePrefix(fenceLangOpen);

    if (prefix.length + s.length <= limit) {
      result.push({ prefix, content: s, suffix: '' });
      break;
    }

    const budget = Math.max(1, limit - prefix.length);
    const maxCut = maxFeasibleCut(s, budget, fenceLangOpen);

    let cut = backOffSurrogate(s, findBreak(s, maxCut));
    if (cut <= 0) cut = 1;

    const shrunk = shrinkToLimit(s, cut, prefix, fenceLangOpen, limit);
    result.push(shrunk.piece);
    fenceLangOpen = shrunk.state;
    s = s.slice(shrunk.cut);
  }

  return result;
}

/**
 * text を limit 文字以内のチャンクに分割する。
 * - コードフェンスをまたいで分割する場合、閉じ直し／開き直しを自動で挿入する。
 * - 段落区切り(\n\n) > 改行(\n) > 空白の優先順で、後ろ半分の範囲だけを探して区切る。
 * - サロゲートペアの途中では切らない。
 */
export function chunkText(text: string, limit: number): string[] {
  return splitPieces(text, limit).map((p) => p.prefix + p.content + p.suffix);
}
