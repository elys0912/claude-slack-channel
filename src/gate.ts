// Slack events_api の受信メッセージを、中継すべきかどうか判定する純関数群（I/O なし）
import type { ParsedAccess } from './config.js';
import type { Verdict } from './types.js';
import { sanitizeMeta } from './format.js';
import { PERMISSION_ID_BODY } from './permission.js';

/** 添付ファイルのうち、Claude に要約して渡す情報だけ */
export interface FileInfo {
  /** Slack のファイル ID（F...）。download_file ツールで取得するときに使う */
  id?: string | undefined;
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

// 区切り（;）・改行・タグや属性の区切りになり得る文字（< > " ' =）は _ に置き換える
const DANGEROUS_NAME_CHARS_RE = /[;\r\n<>"'=]/g;

/** 添付のファイル名・MIME タイプを meta に載せられる形にする（送信者が自由に付けられる値のため） */
function sanitizeAttachmentField(value: string): string {
  return value.replace(DANGEROUS_NAME_CHARS_RE, '_');
}

function buildAttachmentsSummary(files: FileInfo[]): string {
  return files
    .map((f) => {
      const name = sanitizeAttachmentField(f.name ?? '');
      const mimetype = sanitizeAttachmentField(f.mimetype ?? '');
      const size = f.size ?? '';
      return `${name}(${mimetype}, ${size})`;
    })
    .join('; ');
}

/** 本文中のボットへのメンション（`<@U123>` / `<@U123|name>`） */
function mentionRe(botUserId: string, flags = ''): RegExp {
  return new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, flags);
}

function attachmentPlaceholder(files: FileInfo[] | undefined): string {
  const count = files?.length ?? 0;
  if (count > 1) return `(${count} attachments)`;
  return '(attachment)';
}

/**
 * Slack からの受信イベントを判定する。次の順に調べ、最初に当てはまったもので決まる。
 *   1. team_id が access.teamId と違う → drop(team_mismatch)
 *   2. user_team があり access.teamId と違う → drop(user_team_mismatch)
 *   3. channel_type が channel / group（公開・非公開チャンネル）で、access.channels に無い → drop(channel_not_allowed)
 *      channel_type がそれ以外で im でない（グループ DM など） → drop(not_im)
 *   4. bot のメッセージ・user 無し・自分自身 → drop(bot_or_self)
 *   5. subtype が file_share 以外 → drop(unsupported_subtype)
 *   6. user が allowFrom に無い → drop(user_not_allowed)
 *   6'. チャンネル（channel / group）で、ボットへのメンションが無く、ボットが関わっているスレッドへの返信でもない → drop(not_addressed)
 *   7. event_id が既出 → drop(duplicate_event)
 *   8. `yes xxxxx` / `no xxxxx` の形（かつ保留中の ID） → verdict
 *   9. それ以外 → deliver（本文が空なら添付の代わりの文言）
 * isKnownRequest を渡すと、`yes xxxxx` の形でも保留中の request_id でなければ verdict にせず通常のメッセージとして扱う。
 * isActiveThread は、チャンネルのそのスレッドにボットが関わっているか（メンションで話しかけられた・ボットが投稿した）を返す。
 * チャンネルの本文からはボットへのメンションを取り除いて渡す。
 */
export function gate(
  msg: InboundMessage,
  access: ParsedAccess,
  selfBotUserId: string | undefined,
  dedupe: EventDedupe,
  isKnownRequest?: (requestId: string) => boolean,
  isActiveThread?: (channel: string, threadTs: string) => boolean
): GateResult {
  if (msg.teamId === undefined || msg.teamId !== access.teamId) {
    return { kind: 'drop', reason: 'team_mismatch' };
  }
  if (msg.userTeam !== undefined && msg.userTeam !== access.teamId) {
    return { kind: 'drop', reason: 'user_team_mismatch' };
  }
  if (msg.channelType === 'channel' || msg.channelType === 'group') {
    if (msg.channel === undefined || !(access.channels ?? []).includes(msg.channel)) {
      return { kind: 'drop', reason: 'channel_not_allowed' };
    }
  } else if (msg.channelType !== 'im') {
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
  const inChannel = msg.channelType !== 'im';
  let text = msg.text;
  if (inChannel) {
    const mentioned = selfBotUserId !== undefined && mentionRe(selfBotUserId).test(text ?? '');
    const inActiveThread =
      msg.threadTs !== undefined && msg.channel !== undefined && (isActiveThread?.(msg.channel, msg.threadTs) ?? false);
    if (!mentioned && !inActiveThread) {
      return { kind: 'drop', reason: 'not_addressed' };
    }
    if (selfBotUserId !== undefined) text = (text ?? '').replace(mentionRe(selfBotUserId, 'g'), '').trim();
  }
  if (msg.eventId !== undefined && dedupe.seen(msg.eventId)) {
    return { kind: 'drop', reason: 'duplicate_event' };
  }

  const verdict = parsePermissionReply(text ?? '');
  if (verdict && (isKnownRequest === undefined || isKnownRequest(verdict.requestId))) {
    return { kind: 'verdict', verdict };
  }

  const hasText = text !== undefined && text !== '';
  // チャンネルでメンションだけの投稿（添付も無い）は、添付の代わりの文言ではなく本文なしとして渡す
  const content = hasText
    ? (text as string)
    : inChannel && (msg.files?.length ?? 0) === 0
      ? '(本文なし)'
      : attachmentPlaceholder(msg.files);

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
    const ids = msg.files.flatMap((f) => (f.id ? [f.id] : []));
    if (ids.length > 0) rawMeta.attachment_ids = ids.join(',');
  }

  return { kind: 'deliver', content, meta: sanitizeMeta(rawMeta) };
}
