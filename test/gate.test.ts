import { describe, expect, it } from 'vitest';
import { EventDedupe, gate, parsePermissionReply, type InboundMessage } from '../src/gate.js';
import type { AccessConfig } from '../src/types.js';

const access: AccessConfig = { teamId: 'T123', allowFrom: ['U123'] };
const selfBotUserId = 'UBOT1';

function baseMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    teamId: 'T123',
    eventId: 'E1',
    channelType: 'im',
    channel: 'D1',
    user: 'U123',
    userTeam: undefined,
    botId: undefined,
    subtype: undefined,
    text: 'hello',
    ts: '100.1',
    threadTs: undefined,
    files: undefined,
    ...overrides
  };
}

describe('gate', () => {
  it('delivers a DM from an allowed user', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg(), access, selfBotUserId, dedupe);
    expect(result.kind).toBe('deliver');
    if (result.kind === 'deliver') {
      expect(result.content).toBe('hello');
      expect(result.meta.chat_id).toBe('D1');
      expect(result.meta.message_id).toBe('100.1');
      expect(result.meta.thread_ts).toBe('100.1');
      expect(result.meta.user_id).toBe('U123');
      expect(result.meta.ts).toBe('100.1');
    }
  });

  it('drops a message from a user not in allowFrom', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ user: 'U999' }), access, selfBotUserId, dedupe);
    expect(result).toEqual({ kind: 'drop', reason: 'user_not_allowed' });
  });

  it('drops when teamId mismatches', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ teamId: 'TOTHER' }), access, selfBotUserId, dedupe);
    expect(result).toEqual({ kind: 'drop', reason: 'team_mismatch' });
  });

  it('drops when teamId is undefined', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ teamId: undefined }), access, selfBotUserId, dedupe);
    expect(result).toEqual({ kind: 'drop', reason: 'team_mismatch' });
  });

  it('drops when userTeam mismatches (Slack Connect external user)', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ userTeam: 'TEXTERNAL' }), access, selfBotUserId, dedupe);
    expect(result).toEqual({ kind: 'drop', reason: 'user_team_mismatch' });
  });

  it('drops channelType "channel"', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ channelType: 'channel' }), access, selfBotUserId, dedupe);
    expect(result).toEqual({ kind: 'drop', reason: 'not_im' });
  });

  it('drops channelType "mpim"', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ channelType: 'mpim' }), access, selfBotUserId, dedupe);
    expect(result).toEqual({ kind: 'drop', reason: 'not_im' });
  });

  it('drops when botId is present', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ botId: 'B1' }), access, selfBotUserId, dedupe);
    expect(result).toEqual({ kind: 'drop', reason: 'bot_or_self' });
  });

  it('drops messages from the bot itself', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ user: selfBotUserId }), access, selfBotUserId, dedupe);
    expect(result).toEqual({ kind: 'drop', reason: 'bot_or_self' });
  });

  it('drops subtype message_changed', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ subtype: 'message_changed' }), access, selfBotUserId, dedupe);
    expect(result).toEqual({ kind: 'drop', reason: 'unsupported_subtype' });
  });

  it('delivers subtype file_share', () => {
    const dedupe = new EventDedupe();
    const result = gate(
      baseMsg({ subtype: 'file_share', text: '', files: [{ name: 'a.png', mimetype: 'image/png', size: 100 }] }),
      access,
      selfBotUserId,
      dedupe
    );
    expect(result.kind).toBe('deliver');
  });

  it('drops the second occurrence of the same eventId', () => {
    const dedupe = new EventDedupe();
    const first = gate(baseMsg({ eventId: 'DUP' }), access, selfBotUserId, dedupe);
    const second = gate(baseMsg({ eventId: 'DUP' }), access, selfBotUserId, dedupe);
    expect(first.kind).toBe('deliver');
    expect(second).toEqual({ kind: 'drop', reason: 'duplicate_event' });
  });

  it('parses "yes ABCDE" as allow with lowercased id', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ text: 'yes ABCDE' }), access, selfBotUserId, dedupe);
    expect(result).toEqual({ kind: 'verdict', verdict: { requestId: 'abcde', behavior: 'allow' } });
  });

  it('parses "n abcde" as deny', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ text: 'n abcde' }), access, selfBotUserId, dedupe);
    expect(result).toEqual({ kind: 'verdict', verdict: { requestId: 'abcde', behavior: 'deny' } });
  });

  it('treats "yes abcdl" (contains l) as deliver, not verdict', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ text: 'yes abcdl' }), access, selfBotUserId, dedupe);
    expect(result.kind).toBe('deliver');
  });

  it('treats "yes" alone as deliver', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ text: 'yes' }), access, selfBotUserId, dedupe);
    expect(result.kind).toBe('deliver');
  });

  it('treats "please yes abcde" as deliver (not anchored)', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ text: 'please yes abcde' }), access, selfBotUserId, dedupe);
    expect(result.kind).toBe('deliver');
  });

  it('uses (attachment) placeholder when text is empty and one file is present', () => {
    const dedupe = new EventDedupe();
    const result = gate(
      baseMsg({
        subtype: 'file_share',
        text: '',
        files: [{ name: 'evil;name<tag>\r\n.png', mimetype: 'image/png', size: 42 }]
      }),
      access,
      selfBotUserId,
      dedupe
    );
    expect(result.kind).toBe('deliver');
    if (result.kind === 'deliver') {
      expect(result.content).toBe('(attachment)');
      expect(result.meta.attachment_count).toBe('1');
      expect(result.meta.attachments).not.toMatch(/[;\r\n<>]/);
      expect(result.meta.attachments).toContain('evil_name_tag___.png');
    }
  });

  it('does not include undefined-valued keys in meta', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ channel: undefined }), access, selfBotUserId, dedupe);
    expect(result.kind).toBe('deliver');
    if (result.kind === 'deliver') {
      expect('chat_id' in result.meta).toBe(false);
    }
  });

  it('defaults thread_ts to ts when threadTs is undefined', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ ts: '200.2', threadTs: undefined }), access, selfBotUserId, dedupe);
    expect(result.kind).toBe('deliver');
    if (result.kind === 'deliver') {
      expect(result.meta.thread_ts).toBe('200.2');
    }
  });

  it('keeps thread_ts when threadTs is provided', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ ts: '200.2', threadTs: '199.0' }), access, selfBotUserId, dedupe);
    expect(result.kind).toBe('deliver');
    if (result.kind === 'deliver') {
      expect(result.meta.thread_ts).toBe('199.0');
    }
  });
});

describe('EventDedupe', () => {
  it('reports false for the first sighting and true afterwards', () => {
    const dedupe = new EventDedupe(500);
    expect(dedupe.seen('a')).toBe(false);
    expect(dedupe.seen('a')).toBe(true);
  });

  it('evicts the oldest entries once capacity is exceeded', () => {
    const dedupe = new EventDedupe(3);
    expect(dedupe.seen('e1')).toBe(false);
    expect(dedupe.seen('e2')).toBe(false);
    expect(dedupe.seen('e3')).toBe(false);
    expect(dedupe.seen('e4')).toBe(false); // capacity 超過 → e1 が消える
    expect(dedupe.seen('e1')).toBe(false); // 再度初見扱い
    expect(dedupe.seen('e4')).toBe(true); // e4 はまだ憶えている
  });
});

describe('parsePermissionReply', () => {
  it('returns null for non-matching text', () => {
    expect(parsePermissionReply('hello')).toBeNull();
  });

  it('parses uppercase YES', () => {
    expect(parsePermissionReply('YES abcde')).toEqual({ requestId: 'abcde', behavior: 'allow' });
  });

  it('rejects ids with uppercase-required-lowercase mismatch length', () => {
    expect(parsePermissionReply('yes abcd')).toBeNull();
    expect(parsePermissionReply('yes abcdef')).toBeNull();
  });
});
