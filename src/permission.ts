// permission relay（Slack 上での実行許可のやり取り）に関する純関数群（I/O なし）
import type { ParsedAccess } from './config.js';
import type { Verdict } from './types.js';
import { neutralizeBroadcasts } from './format.js';

export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

/** request_id の文字集合（小文字 5 文字、l を除く）。gate.ts の返信パターンもこれから組み立てる */
export const PERMISSION_ID_BODY = '[a-km-z]{5}';
export const PERMISSION_ID_RE = new RegExp(`^${PERMISSION_ID_BODY}$`);

export function isValidRequestId(id: string): boolean {
  return PERMISSION_ID_RE.test(id);
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

interface PendingEntry {
  req: PermissionRequest;
  expiresAt: number;
}

/** 保留中の permission request を TTL 付きで管理する（時刻注入でテスト可能） */
export class PendingPermissions {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly store: Map<string, PendingEntry>;

  constructor(ttlMs: number = DEFAULT_TTL_MS, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.store = new Map();
  }

  /** 有効期限（ミリ秒） */
  get ttl(): number {
    return this.ttlMs;
  }

  add(req: PermissionRequest): void {
    this.store.set(req.request_id, { req, expiresAt: this.now() + this.ttlMs });
  }

  /** 期限内なら返すだけで残す（See more 用）。期限切れならここで消して undefined */
  get(id: string): PermissionRequest | undefined {
    const entry = this.store.get(id);
    if (!entry) return undefined;
    if (this.now() > entry.expiresAt) {
      this.store.delete(id);
      return undefined;
    }
    return entry.req;
  }

  /** 取り出して消す（回答用。同じ ID に二度答えさせない）。期限切れなら消したうえで undefined */
  take(id: string): PermissionRequest | undefined {
    const entry = this.store.get(id);
    if (!entry) return undefined;
    this.store.delete(id);
    if (this.now() > entry.expiresAt) return undefined;
    return entry.req;
  }

  /** 期限に関係なく取り出して消す（自動 deny 用） */
  remove(id: string): PermissionRequest | undefined {
    const entry = this.store.get(id);
    this.store.delete(id);
    return entry?.req;
  }

  prune(): void {
    const t = this.now();
    for (const [id, entry] of this.store) {
      if (t > entry.expiresAt) this.store.delete(id);
    }
  }
}

const PLAIN_TEXT_LIMIT = 3000;

/**
 * 表示を偽装できる不可視文字。承認画面で実際と違う内容に見せられないよう、`\u{202E}` の形で見えるようにする。
 * - 双方向制御: U+202A-202E / U+2066-2069 と、向きの印 U+200E-200F / U+061C
 * - ゼロ幅・結合制御: U+200B-200D / U+2060-2064 / U+034F / U+180E、BOM U+FEFF
 * - 空白に見える埋め文字: U+00AD（ソフトハイフン）/ U+115F-1160 / U+17B4-17B5 / U+3164 / U+FFA0
 * - C0・C1 制御文字（タブ・改行・復帰は除く）: U+0000-0008 / U+000B-000C / U+000E-001F / U+007F-009F
 */
const INVISIBLE_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁦-⁩ㅤ﻿ﾠ]/;

function visibleUnit(ch: string): string {
  if (!INVISIBLE_RE.test(ch)) return ch;
  return `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase()}}`;
}

/** 表示単位（コードポイント 1 つ、または不可視文字のエスケープ 1 つ）に分ける。途中で切ってもサロゲートやエスケープが割れない */
function toVisibleUnits(text: string): string[] {
  return Array.from(text, visibleUnit);
}

/** 不可視文字を `\u{XXXX}` に置き換える（See more の全文表示でも使う） */
export function revealInvisible(text: string): string {
  return toVisibleUnits(text).join('');
}

/** units の先頭から、UTF-16 長の合計が budget 以内に収まるだけ取る */
function takeHead(units: readonly string[], budget: number): string[] {
  const out: string[] = [];
  let len = 0;
  for (const u of units) {
    if (len + u.length > budget) break;
    out.push(u);
    len += u.length;
  }
  return out;
}

function unitsLength(units: readonly string[]): number {
  return units.reduce((n, u) => n + u.length, 0);
}

/** 不可視文字を見えるようにしたうえで、maxLen 以内に先頭だけ残して切り詰める */
function truncatePlain(text: string, maxLen: number): { text: string; truncated: boolean } {
  const units = toVisibleUnits(text);
  if (unitsLength(units) <= maxLen) return { text: units.join(''), truncated: false };
  return { text: takeHead(units, Math.max(0, maxLen - 1)).join('') + '…', truncated: true };
}

/** 切り詰めたプレビューの末尾側に残す割合（既定 2800 なら 省略表示を除いて 先頭 約 2200 + 末尾 約 600） */
const PREVIEW_TAIL_RATIO = 0.22;

/**
 * input_preview 用: 長いときは先頭と末尾の両方を残し、間に省略した文字数を入れる。
 * コマンドの末尾に危険な部分を置いて先頭だけ見せる、という偽装を防ぐため。
 */
function truncateHeadTail(text: string, maxLen: number): { text: string; truncated: boolean } {
  const units = toVisibleUnits(text);
  const total = unitsLength(units);
  if (total <= maxLen) return { text: units.join(''), truncated: false };

  // 省略表示の桁数は total 以下なので、total で見積もれば長さの上限を超えない
  const marker = (n: number) => `\n…（途中 ${n} 文字省略）…\n`;
  const budget = Math.max(0, maxLen - marker(total).length);
  const tailBudget = Math.floor(budget * PREVIEW_TAIL_RATIO);
  const head = takeHead(units, budget - tailBudget);
  const tail = takeHead([...units.slice(head.length)].reverse(), tailBudget).reverse();
  const omitted = total - unitsLength(head) - unitsLength(tail);
  return { text: head.join('') + marker(omitted) + tail.join(''), truncated: true };
}

const PREVIEW_TRUNCATED_WARNING =
  '⚠️ 入力が長いため途中を省略している。許可する前に See more で全文を確認すること';

/** 等幅で表示するブロック（input_preview の表示用） */
export function preformattedBlock(text: string): unknown {
  return {
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_preformatted',
        elements: [{ type: 'text', text }]
      }
    ]
  };
}

function button(label: string, actionId: string, requestId: string, style?: 'primary' | 'danger'): unknown {
  return {
    type: 'button',
    text: { type: 'plain_text', text: label },
    ...(style ? { style } : {}),
    action_id: actionId,
    value: requestId
  };
}

/** Slack は空（空白だけ）の text を持つブロックを受け付けないので、そのときは代わりの文言にする */
function orPlaceholder(text: string, placeholder: string): string {
  return text.trim() === '' ? placeholder : text;
}

/**
 * 実行許可を求めるメッセージのブロックを組み立てる。不可視文字はどの欄も `\u{XXXX}` にして表示する。
 * - tool_name / description: plain_text の上限（3000）に収まるよう先頭だけ残し、末尾を … にする
 * - input_preview: previewLimit（既定 2800）を超えたら先頭と末尾を残し、間に省略した文字数を入れ、警告行を足す
 * - どれかを省略したときだけ See more ボタンを付ける（戻り値の truncated も同じ条件）
 * 空（空白だけ）の欄は代わりの文言にする。
 */
export function buildPermissionBlocks(
  req: PermissionRequest,
  previewLimit: number = 2800
): { text: string; blocks: unknown[]; truncated: boolean } {
  const toolNameResult = truncatePlain(orPlaceholder(req.tool_name, '(不明なツール)'), PLAIN_TEXT_LIMIT - 'Tool: '.length);
  const descriptionResult = truncatePlain(orPlaceholder(req.description, '(説明なし)'), PLAIN_TEXT_LIMIT);
  const previewResult = truncateHeadTail(orPlaceholder(req.input_preview, '(入力なし)'), previewLimit);

  const truncated = toolNameResult.truncated || descriptionResult.truncated || previewResult.truncated;

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🔐 Permission request', emoji: true }
    },
    {
      type: 'section',
      text: { type: 'plain_text', text: `Tool: ${toolNameResult.text}` }
    },
    {
      type: 'section',
      text: { type: 'plain_text', text: descriptionResult.text }
    },
    preformattedBlock(previewResult.text),
    // 省略したときだけ警告行を足す（省略していなければ従来どおりのブロック構成）
    ...(previewResult.truncated
      ? [{ type: 'context', elements: [{ type: 'plain_text', text: PREVIEW_TRUNCATED_WARNING }] }]
      : []),
    {
      type: 'context',
      elements: [
        {
          type: 'plain_text',
          text: `ID: ${req.request_id} ／ テキストで "yes ${req.request_id}" / "no ${req.request_id}" でも回答できる`
        }
      ]
    },
    {
      type: 'actions',
      elements: [
        button('Allow', 'perm_allow', req.request_id, 'primary'),
        button('♾ 今後も許可', 'perm_always', req.request_id),
        button('Deny', 'perm_deny', req.request_id, 'danger'),
        // 省略した部分があるときだけ、全文を出すボタンを付ける
        ...(truncated ? [button('See more', 'perm_more', req.request_id)] : [])
      ]
    }
  ];

  return {
    text: neutralizeBroadcasts(`🔐 Permission: ${req.tool_name}`),
    blocks,
    truncated
  };
}

const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,}$/;

export function buildResolvedBlocks(
  req: PermissionRequest,
  behavior: 'allow' | 'deny',
  byUserId: string
): { text: string; blocks: unknown[] } {
  const verb = behavior === 'allow' ? 'Allowed' : 'Denied';
  const emoji = behavior === 'allow' ? '✅' : '❌';
  const toolNameResult = truncatePlain(orPlaceholder(req.tool_name, '(不明なツール)'), PLAIN_TEXT_LIMIT - (verb.length + 3));

  const blocks: unknown[] = [
    {
      type: 'section',
      text: { type: 'plain_text', text: `${verb}: ${toolNameResult.text}` }
    },
    {
      type: 'context',
      elements: [
        // 文字列は plain_text で出す（mrkdwn として解釈させない）。
        // メンション表示のためだけに、Slack のユーザー ID の形をしているときに限り mrkdwn の <@...> を使う
        { type: 'plain_text', text: `ID: ${orPlaceholder(req.request_id, '-')} ・ by` },
        SLACK_USER_ID_RE.test(byUserId)
          ? { type: 'mrkdwn', text: `<@${byUserId}>` }
          : { type: 'plain_text', text: orPlaceholder(byUserId, '(不明)') }
      ]
    }
  ];

  return {
    text: neutralizeBroadcasts(`${emoji} ${verb}: ${req.tool_name}`),
    blocks
  };
}

export function buildExpiredBlocks(requestId: string): { text: string; blocks: unknown[] } {
  const blocks: unknown[] = [
    {
      type: 'section',
      text: { type: 'plain_text', text: `⌛ Permission request ${requestId} expired` }
    }
  ];
  return {
    text: neutralizeBroadcasts(`⌛ Permission request ${requestId} expired`),
    blocks
  };
}

/** 1 行の知らせ（plain_text の section 1 つ） */
function noticeBlocks(text: string): { text: string; blocks: unknown[] } {
  const safe = neutralizeBroadcasts(text);
  return { text: safe, blocks: [{ type: 'section', text: { type: 'plain_text', text: safe } }] };
}

/** 回答が無いまま自動で deny したときの表示。reason は「期限切れ」のような固定の文言（「〜のため自動で拒否した」に続く） */
export function buildAutoDeniedBlocks(requestId: string, reason: string): { text: string; blocks: unknown[] } {
  return noticeBlocks(`⌛ Permission request ${requestId}: ${reason}のため自動で拒否した`);
}

/** 回答を Claude に送れなかったときの表示（MCP の切断など。Claude 側は自分の期限で止まる） */
export function buildVerdictFailedBlocks(requestId: string, behavior: 'allow' | 'deny'): { text: string; blocks: unknown[] } {
  const verb = behavior === 'allow' ? 'Allow' : 'Deny';
  return noticeBlocks(`⚠️ Permission request ${requestId}: ${verb} を Claude に送れなかった。Claude Code のセッションを確認すること`);
}

export interface BlockActionInput {
  type?: string | undefined;
  teamId?: string | undefined;
  userId?: string | undefined;
  channelId?: string | undefined;
  actionId?: string | undefined;
  value?: string | undefined;
}

export type ActionParse =
  | { ok: true; kind: 'verdict'; verdict: Verdict }
  | { ok: true; kind: 'see_more'; requestId: string }
  /** 今回は許可し、同じ種類の操作を許可リストに足す提案を出す */
  | { ok: true; kind: 'allow_always'; requestId: string }
  /** ターミナルの画面を確認する */
  | { ok: true; kind: 'screen_show' }
  /** 画面の選択肢を選ぶ（snapshotId は画面を見せたときの控え） */
  | { ok: true; kind: 'screen_pick'; snapshotId: string; index: number }
  /** 許可リストへの追加の提案に答える */
  | { ok: true; kind: 'rule_confirm'; proposalId: string; accept: boolean }
  /** 許可リストから追加分のルールを消す */
  | { ok: true; kind: 'rule_remove'; rule: string }
  | { ok: false; reason: string };

/** 画面の控え・提案の ID（ブリッジが発行する英小文字と数字 8 文字） */
export const TOKEN_ID_RE = /^[a-z0-9]{8}$/;
const SCREEN_PICK_RE = /^([a-z0-9]{8})\.(\d)$/;
/** rule_remove の value（ルールそのもの）の長さの上限 */
const RULE_VALUE_MAX = 500;

/** request_id を value に持たないボタン。該当しなければ undefined（従来の perm_* の判定に進む） */
function parseToolAction(actionId: string | undefined, value: string | undefined): ActionParse | undefined {
  // 同じブロックに並ぶボタンは action_id に番号が付く（screen_pick_0, rule_remove_3, ...）
  const numbered = actionId === undefined ? undefined : /^(screen_pick|rule_remove)_\d{1,2}$/.exec(actionId);
  const normalized = numbered ? numbered[1] : actionId;
  switch (normalized) {
    case 'screen_show':
      return { ok: true, kind: 'screen_show' };
    case 'screen_pick': {
      const m = SCREEN_PICK_RE.exec(value ?? '');
      if (!m) return { ok: false, reason: 'invalid_value' };
      return { ok: true, kind: 'screen_pick', snapshotId: m[1] ?? '', index: Number(m[2]) };
    }
    case 'rule_add':
    case 'rule_cancel':
      if (!TOKEN_ID_RE.test(value ?? '')) return { ok: false, reason: 'invalid_value' };
      return { ok: true, kind: 'rule_confirm', proposalId: value ?? '', accept: actionId === 'rule_add' };
    case 'rule_remove':
      if (!value || value.length > RULE_VALUE_MAX) return { ok: false, reason: 'invalid_value' };
      return { ok: true, kind: 'rule_remove', rule: value };
    default:
      return undefined;
  }
}

/**
 * block_actions のボタン操作を検証して解釈する。次の順に調べ、最初に外れた理由で ok: false を返す:
 * type が block_actions → team が access.teamId → 押した人が allowFrom → チャンネルが許可ユーザーの DM か access.channels
 * → （画面・許可リスト操作のボタンならその value の形）→ value が request_id の形 → action_id（perm_allow / perm_deny / perm_more / perm_always）。
 * 保留中の ID かどうかはここでは見ない（呼び出し側の PermissionRelay が判断する）。
 */
export function parseBlockAction(
  input: BlockActionInput,
  access: ParsedAccess,
  allowedChannels: ReadonlySet<string>
): ActionParse {
  if (input.type !== 'block_actions') {
    return { ok: false, reason: 'not_block_actions' };
  }
  if (input.teamId !== access.teamId) {
    return { ok: false, reason: 'team_mismatch' };
  }
  if (input.userId === undefined || !access.allowFrom.includes(input.userId)) {
    return { ok: false, reason: 'user_not_allowed' };
  }
  if (input.channelId === undefined || !allowedChannels.has(input.channelId)) {
    return { ok: false, reason: 'channel_not_allowed' };
  }
  const toolAction = parseToolAction(input.actionId, input.value);
  if (toolAction) return toolAction;
  if (input.value === undefined || !isValidRequestId(input.value)) {
    return { ok: false, reason: 'invalid_request_id' };
  }

  switch (input.actionId) {
    case 'perm_allow':
      return { ok: true, kind: 'verdict', verdict: { requestId: input.value, behavior: 'allow' } };
    case 'perm_deny':
      return { ok: true, kind: 'verdict', verdict: { requestId: input.value, behavior: 'deny' } };
    case 'perm_more':
      return { ok: true, kind: 'see_more', requestId: input.value };
    case 'perm_always':
      return { ok: true, kind: 'allow_always', requestId: input.value };
    default:
      return { ok: false, reason: 'unknown_action' };
  }
}
