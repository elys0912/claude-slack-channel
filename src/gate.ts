// Slack events_api の受信メッセージを、中継すべきかどうか判定する純関数群（I/O なし）
import type { ParsedAccess } from './config.js';
import type { Verdict } from './types.js';
import { sanitizeMeta } from './format.js';
import { PERMISSION_ID_BODY } from './permission.js';

/** 添付ファイルのうち、Claude に要約して渡す情報だけ */
export interface FileInfo {
  name?: string | undefined;
  mimetype?: string | undefined;
  size?: number | undefined;
}

export interface InboundMessage {
  teamId: string | undefined;
  eventId: string | undefined;
  channelType: string | undefined;
  channel: string | undefined;
  user: string | undefined;
  userTeam: string | undefined;
  botId: string | undefined;
  subtype: string | undefined;
  text: string | undefined;
  ts: string | undefined;
  threadTs: string | undefined;
  files: FileInfo[] | undefined;
}

export type GateResult =
  | { kind: 'drop'; reason: string }
  | { kind: 'verdict'; verdict: Verdict }
  | { kind: 'deliver'; content: string; meta: Record<string, string> };

const DEFAULT_DEDUPE_CAPACITY = 500;

/** 直近見た eventId を憶えておき、二重配信を弾く（容量超過で古いものから破棄） */
export class EventDedupe {
  private readonly capacity: number;
  private readonly store: Map<string, true>;

  constructor(capacity: number = DEFAULT_DEDUPE_CAPACITY) {
    this.capacity = capacity;
    this.store = new Map();
  }

  /** 初見なら記録して false、既に見たものなら true を返す */
  seen(eventId: string): boolean {
    if (this.store.has(eventId)) return true;
    this.store.set(eventId, true);
    if (this.store.size > this.capacity) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    return false;
  }
}

// ボタン側（parseBlockAction）は小文字のみ受け付けるが、返信側は大文字も受けて小文字化する
const PERMISSION_REPLY_RE = new RegExp(String.raw`^\s*(y|yes|n|no)\s+(${PERMISSION_ID_BODY})\s*$`, 'i');

/** permission relay への返信テキストをパースする（y/yes→allow, n/no→deny, ID は小文字化） */
export function parsePermissionReply(text: string): Verdict | null {
  const m = PERMISSION_REPLY_RE.exec(text);
  if (!m) return null;
  const word = (m[1] ?? '').toLowerCase();
  const requestId = (m[2] ?? '').toLowerCase();
  const behavior: 'allow' | 'deny' = word === 'y' || word === 'yes' ? 'allow' : 'deny';
  return { requestId, behavior };
}

const DANGEROUS_NAME_CHARS_RE = /[;\r\n<>]/g;

function sanitizeAttachmentName(name: string): string {
  return name.replace(DANGEROUS_NAME_CHARS_RE, '_');
}

function buildAttachmentsSummary(files: FileInfo[]): string {
  return files
    .map((f) => {
      const name = sanitizeAttachmentName(f.name ?? '');
      const mimetype = f.mimetype ?? '';
      const size = f.size ?? '';
      return `${name}(${mimetype}, ${size})`;
    })
    .join('; ');
}

function attachmentPlaceholder(files: FileInfo[] | undefined): string {
  const count = files?.length ?? 0;
  if (count > 1) return `(${count} attachments)`;
  return '(attachment)';
}

/**
 * Slack からの受信イベントを判定する。判定順は仕様書のとおり最初に当てはまったもので決まる。
 * isKnownRequest を渡すと、`yes xxxxx` の形でも保留中の request_id でなければ verdict にせず通常のメッセージとして扱う。
 */
export function gate(
  msg: InboundMessage,
  access: ParsedAccess,
  selfBotUserId: string | undefined,
  dedupe: EventDedupe,
  isKnownRequest?: (requestId: string) => boolean
): GateResult {
  if (msg.teamId === undefined || msg.teamId !== access.teamId) {
    return { kind: 'drop', reason: 'team_mismatch' };
  }
  if (msg.userTeam !== undefined && msg.userTeam !== access.teamId) {
    return { kind: 'drop', reason: 'user_team_mismatch' };
  }
  if (msg.channelType !== 'im') {
    return { kind: 'drop', reason: 'not_im' };
  }
  if (msg.botId !== undefined || msg.user === undefined || msg.user === '' || msg.user === selfBotUserId) {
    return { kind: 'drop', reason: 'bot_or_self' };
  }
  if (msg.subtype !== undefined && msg.subtype !== 'file_share') {
    return { kind: 'drop', reason: 'unsupported_subtype' };
  }
  if (!access.allowFrom.includes(msg.user)) {
    return { kind: 'drop', reason: 'user_not_allowed' };
  }
  if (msg.eventId !== undefined && dedupe.seen(msg.eventId)) {
    return { kind: 'drop', reason: 'duplicate_event' };
  }

  const verdict = parsePermissionReply(msg.text ?? '');
  if (verdict && (isKnownRequest === undefined || isKnownRequest(verdict.requestId))) {
    return { kind: 'verdict', verdict };
  }

  const hasText = msg.text !== undefined && msg.text !== '';
  const content = hasText ? (msg.text as string) : attachmentPlaceholder(msg.files);

  const rawMeta: Record<string, string | undefined> = {
    chat_id: msg.channel,
    message_id: msg.ts,
    thread_ts: msg.threadTs ?? msg.ts,
    user_id: msg.user,
    ts: msg.ts
  };
  if (msg.files !== undefined) {
    rawMeta.attachment_count = String(msg.files.length);
    rawMeta.attachments = buildAttachmentsSummary(msg.files);
  }

  return { kind: 'deliver', content, meta: sanitizeMeta(rawMeta) };
}
