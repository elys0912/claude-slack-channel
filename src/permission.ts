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

  add(req: PermissionRequest): void {
    this.store.set(req.request_id, { req, expiresAt: this.now() + this.ttlMs });
  }

  get(id: string): PermissionRequest | undefined {
    const entry = this.store.get(id);
    if (!entry) return undefined;
    if (this.now() > entry.expiresAt) {
      this.store.delete(id);
      return undefined;
    }
    return entry.req;
  }

  take(id: string): PermissionRequest | undefined {
    const entry = this.store.get(id);
    if (!entry) return undefined;
    this.store.delete(id);
    if (this.now() > entry.expiresAt) return undefined;
    return entry.req;
  }

  prune(): void {
    const t = this.now();
    for (const [id, entry] of this.store) {
      if (t > entry.expiresAt) this.store.delete(id);
    }
  }
}

const PLAIN_TEXT_LIMIT = 3000;

function truncatePlain(text: string, maxLen: number): { text: string; truncated: boolean } {
  if (text.length <= maxLen) return { text, truncated: false };
  const cut = Math.max(0, maxLen - 1);
  return { text: text.slice(0, cut) + '…', truncated: true };
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

function button(label: string, actionId: string, requestId: string, style?: 'primary' | 'danger'): unknown {
  return {
    type: 'button',
    text: { type: 'plain_text', text: label },
    ...(style ? { style } : {}),
    action_id: actionId,
    value: requestId
  };
}

export function buildPermissionBlocks(
  req: PermissionRequest,
  previewLimit: number = 2800
): { text: string; blocks: unknown[]; truncated: boolean } {
  const toolNameResult = truncatePlain(req.tool_name, PLAIN_TEXT_LIMIT - 'Tool: '.length);
  const descriptionResult = truncatePlain(req.description, PLAIN_TEXT_LIMIT);
  const previewResult = truncatePlain(req.input_preview, previewLimit);

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

export function buildResolvedBlocks(
  req: PermissionRequest,
  behavior: 'allow' | 'deny',
  byUserId: string
): { text: string; blocks: unknown[] } {
  const verb = behavior === 'allow' ? 'Allowed' : 'Denied';
  const emoji = behavior === 'allow' ? '✅' : '❌';
  const toolNameResult = truncatePlain(req.tool_name, PLAIN_TEXT_LIMIT - (verb.length + 3));

  const blocks: unknown[] = [
    {
      type: 'section',
      text: { type: 'plain_text', text: `${verb}: ${toolNameResult.text}` }
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `ID: ${req.request_id} ・ by <@${byUserId}>`
        }
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
  | { ok: false; reason: string };

export function parseBlockAction(
  input: BlockActionInput,
  access: ParsedAccess,
  allowedDmChannels: ReadonlySet<string>
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
  if (input.channelId === undefined || !allowedDmChannels.has(input.channelId)) {
    return { ok: false, reason: 'channel_not_allowed' };
  }
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
    default:
      return { ok: false, reason: 'unknown_action' };
  }
}
