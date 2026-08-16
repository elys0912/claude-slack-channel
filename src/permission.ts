// permission relay（Slack 上での実行許可のやり取り）に関する純関数群（I/O なし）
import type { ParsedAccess } from './config.js';
import type { Verdict } from './types.js';
import { neutralizeBroadcasts } from './format.js';
import { TOKEN_ID_BODY, TOKEN_ID_RE } from './text.js';
import { button, plainContext, plainSection } from './blocks.js';
import { isValidRequestId, DEFAULT_PREVIEW_LIMIT, truncatePlain, truncateHeadTail, PREVIEW_TRUNCATED_WARNING, orPlaceholder } from './permission-core.js';
import type { PermissionRequest } from './permission-core.js';

// チャネルによらない部分は permission-core.ts。ほかのモジュールからは今までどおりここから使える
export { PERMISSION_ID_BODY, PERMISSION_ID_RE, isValidRequestId, PendingPermissions, DEFAULT_PREVIEW_LIMIT, revealInvisible, truncatePlain, truncateHeadTail, PREVIEW_TRUNCATED_WARNING, orPlaceholder } from './permission-core.js';
export { TOKEN_ID_RE } from './text.js';
export type { PermissionRequest } from './permission-core.js';

/** Block Kit の plain_text（section / context）の文字数の上限 */
export const PLAIN_TEXT_LIMIT = 3000;

/**
 * ボタンの action_id。出す側（この module・screen-relay.ts・rule-relay.ts）と解釈する側（parseBlockAction）で共用する。
 * SCREEN_PICK / RULE_REMOVE は同じ actions ブロックに並ぶので `_<番号>` を付けて使う（action_id は 1 ブロック内で重複できない）
 */
export const ACTION = {
  ALLOW: 'perm_allow',
  ALLOW_ALWAYS: 'perm_always',
  ALLOW_SESSION: 'perm_session',
  DENY: 'perm_deny',
  SEE_MORE: 'perm_more',
  SCREEN_SHOW: 'screen_show',
  SCREEN_PICK: 'screen_pick',
  RULE_ADD: 'rule_add',
  RULE_CANCEL: 'rule_cancel',
  RULE_REMOVE: 'rule_remove',
} as const;

/** 同じブロックに並ぶボタンの action_id（`screen_pick_0` など） */
export function numberedAction(base: typeof ACTION.SCREEN_PICK | typeof ACTION.RULE_REMOVE, index: number): string {
  return `${base}_${index}`;
}

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

export interface PermissionBlocksOptions {
  /** input_preview を省略せずに出す長さ（既定 DEFAULT_PREVIEW_LIMIT） */
  previewLimit?: number;
  /** 「このセッション中は全部許可」ボタンを付けるか */
  showSessionButton?: boolean;
  /** 「♾ 今後も許可」ボタンを付けるか（許可リストに足せるルールを作れるリクエストだけ） */
  showAlwaysButton?: boolean;
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
  { previewLimit = DEFAULT_PREVIEW_LIMIT, showSessionButton = false, showAlwaysButton = false }: PermissionBlocksOptions = {}
): { text: string; blocks: unknown[]; truncated: boolean } {
  const toolLabel = 'Tool: ';
  const toolNameResult = truncatePlain(orPlaceholder(req.tool_name, '(不明なツール)'), PLAIN_TEXT_LIMIT - toolLabel.length);
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
      text: { type: 'plain_text', text: `${toolLabel}${toolNameResult.text}` }
    },
    {
      type: 'section',
      text: { type: 'plain_text', text: descriptionResult.text }
    },
    preformattedBlock(previewResult.text),
    // 省略したときだけ警告行を足す（省略していなければ従来どおりのブロック構成）
    ...(previewResult.truncated ? [plainContext(PREVIEW_TRUNCATED_WARNING)] : []),
    plainContext(`ID: ${req.request_id} ／ テキストで "yes ${req.request_id}" / "no ${req.request_id}" でも回答できる`),
    {
      type: 'actions',
      elements: [
        button('Allow', ACTION.ALLOW, req.request_id, 'primary'),
        ...(showAlwaysButton ? [button('♾ 今後も許可', ACTION.ALLOW_ALWAYS, req.request_id)] : []),
        ...(showSessionButton ? [button('🔓 このセッション中は全部許可', ACTION.ALLOW_SESSION, req.request_id)] : []),
        button('Deny', ACTION.DENY, req.request_id, 'danger'),
        // 省略した部分があるときだけ、全文を出すボタンを付ける
        ...(truncated ? [button('See more', ACTION.SEE_MORE, req.request_id)] : [])
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
  const label = `${verb}: `;
  // 従来は見出しの余裕を verb + 3 文字で見積もっていた（`: ` の 2 文字 + 1 文字の余裕）。表示を変えないよう同じ値にする
  const toolNameResult = truncatePlain(orPlaceholder(req.tool_name, '(不明なツール)'), PLAIN_TEXT_LIMIT - (label.length + 1));

  const blocks: unknown[] = [
    {
      type: 'section',
      text: { type: 'plain_text', text: `${label}${toolNameResult.text}` }
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

/** 1 行の知らせ（plain_text の section 1 つ）。text も section も @channel などを無効にした文にする */
function oneLineView(text: string): { text: string; blocks: unknown[] } {
  const safe = neutralizeBroadcasts(text);
  return { text: safe, blocks: [plainSection(safe)] };
}

/**
 * 期限切れのボタンが押されたときの表示。
 * requestId は parseBlockAction で検証済み（英小文字 5 文字）なので、section 側も neutralizeBroadcasts を通した文にしても表示は変わらない
 */
export function buildExpiredBlocks(requestId: string): { text: string; blocks: unknown[] } {
  return oneLineView(`⌛ Permission request ${requestId} expired`);
}

/** 回答が無いまま自動で deny したときの表示。reason は「期限切れ」のような固定の文言（「〜のため自動で拒否した」に続く） */
export function buildAutoDeniedBlocks(requestId: string, reason: string): { text: string; blocks: unknown[] } {
  return oneLineView(`⌛ Permission request ${requestId}: ${reason}のため自動で拒否した`);
}

/** 回答を Claude に送れなかったときの表示（MCP の切断など。Claude 側は自分の期限で止まる） */
export function buildVerdictFailedBlocks(requestId: string, behavior: 'allow' | 'deny'): { text: string; blocks: unknown[] } {
  const verb = behavior === 'allow' ? 'Allow' : 'Deny';
  return oneLineView(`⚠️ Permission request ${requestId}: ${verb} を Claude に送れなかった。Claude Code のセッションを確認すること`);
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
  /** 今回は許可し、このセッション中は settings の ask / deny 以外を自動で許可する */
  | { ok: true; kind: 'allow_session'; requestId: string }
  /** ターミナルの画面を確認する */
  | { ok: true; kind: 'screen_show' }
  /** 画面の選択肢を選ぶ（snapshotId は画面を見せたときの控え） */
  | { ok: true; kind: 'screen_pick'; snapshotId: string; index: number }
  /** 許可リストへの追加の提案に答える */
  | { ok: true; kind: 'rule_confirm'; proposalId: string; accept: boolean }
  /** 許可リストから追加分のルールを消す */
  | { ok: true; kind: 'rule_remove'; rule: string }
  | { ok: false; reason: string };

/** screen_pick の value（`<控えの ID>.<選択肢の番号 1 桁>`。screen.ts の MAX_OPTIONS が 9 なので 1 桁で足りる） */
const SCREEN_PICK_RE = new RegExp(`^(${TOKEN_ID_BODY})\\.(\\d)$`);
/** 同じブロックに並ぶボタン（`screen_pick_0` / `rule_remove_3` など）。番号は 2 桁まで */
const NUMBERED_ACTION_RE = new RegExp(`^(${ACTION.SCREEN_PICK}|${ACTION.RULE_REMOVE})_\\d{1,2}$`);
/** rule_remove の value（ルールそのもの）の長さの上限 */
const RULE_VALUE_MAX = 500;

/** request_id を value に持たないボタン。該当しなければ undefined（従来の perm_* の判定に進む） */
function parseToolAction(actionId: string | undefined, value: string | undefined): ActionParse | undefined {
  // 同じブロックに並ぶボタンは action_id に番号が付く（screen_pick_0, rule_remove_3, ...）
  const numbered = actionId === undefined ? undefined : NUMBERED_ACTION_RE.exec(actionId);
  const normalized = numbered ? numbered[1] : actionId;
  switch (normalized) {
    case ACTION.SCREEN_SHOW:
      return { ok: true, kind: 'screen_show' };
    case ACTION.SCREEN_PICK: {
      const m = SCREEN_PICK_RE.exec(value ?? '');
      if (!m) return { ok: false, reason: 'invalid_value' };
      return { ok: true, kind: 'screen_pick', snapshotId: m[1] ?? '', index: Number(m[2]) };
    }
    case ACTION.RULE_ADD:
    case ACTION.RULE_CANCEL:
      if (!TOKEN_ID_RE.test(value ?? '')) return { ok: false, reason: 'invalid_value' };
      return { ok: true, kind: 'rule_confirm', proposalId: value ?? '', accept: actionId === ACTION.RULE_ADD };
    case ACTION.RULE_REMOVE:
      if (!value || value.length > RULE_VALUE_MAX) return { ok: false, reason: 'invalid_value' };
      return { ok: true, kind: 'rule_remove', rule: value };
    default:
      return undefined;
  }
}

/**
 * block_actions のボタン操作を検証して解釈する。次の順に調べ、最初に外れた理由で ok: false を返す:
 * type が block_actions → team が access.teamId → 押した人が allowFrom → チャンネルが許可ユーザーの DM か access.channels
 * → （画面・許可リスト操作のボタンならその value の形）→ value が request_id の形 → action_id（perm_allow / perm_deny / perm_more / perm_always / perm_session）。
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
    case ACTION.ALLOW:
      return { ok: true, kind: 'verdict', verdict: { requestId: input.value, behavior: 'allow' } };
    case ACTION.DENY:
      return { ok: true, kind: 'verdict', verdict: { requestId: input.value, behavior: 'deny' } };
    case ACTION.SEE_MORE:
      return { ok: true, kind: 'see_more', requestId: input.value };
    case ACTION.ALLOW_ALWAYS:
      return { ok: true, kind: 'allow_always', requestId: input.value };
    case ACTION.ALLOW_SESSION:
      return { ok: true, kind: 'allow_session', requestId: input.value };
    default:
      return { ok: false, reason: 'unknown_action' };
  }
}
