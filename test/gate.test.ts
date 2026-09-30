import { describe, expect, it } from 'vitest';
import { EventDedupe, gate, parsePermissionReply, type InboundMessage } from '../src/gate.js';
import type { ParsedAccess } from '../src/config.js';

const access: ParsedAccess = { teamId: 'T123', allowFrom: ['U123'] };
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

  it('drops channelType "channel" when channels is not configured', () => {
    const dedupe = new EventDedupe();
    const result = gate(baseMsg({ channelType: 'channel', channel: 'C1' }), access, selfBotUserId, dedupe);
    expect(result).toEqual({ kind: 'drop', reason: 'channel_not_allowed' });
  });

  it.each(['channel', 'group'])('delivers a "%s" message when the channel is in channels', (channelType) => {
    const dedupe = new EventDedupe();
    const withChannels = { ...access, channels: ['C1'] };
    const result = gate(
      baseMsg({ channelType, channel: 'C1', ts: '200.1', threadTs: '150.0', text: `<@${selfBotUserId}> hello` }),
      withChannels,
      selfBotUserId,
      dedupe
    );
    expect(result.kind).toBe('deliver');
    if (result.kind === 'deliver') {
      expect(result.content).toBe('hello');
      expect(result.meta.chat_id).toBe('C1');
      expect(result.meta.thread_ts).toBe('150.0');
    }
  });

  describe('チャンネルではメンションか、ボットが関わるスレッドへの返信だけ受け付ける', () => {
    const withChannels = { ...access, channels: ['C1'] };
    const inChannel = (overrides: Partial<InboundMessage> = {}) =>
      baseMsg({ channelType: 'channel', channel: 'C1', ts: '200.1', ...overrides });

    it('メンションもスレッドも無ければ not_addressed', () => {
      expect(gate(inChannel(), withChannels, selfBotUserId, new EventDedupe())).toEqual({
        kind: 'drop',
        reason: 'not_addressed',
      });
    });

    it('関わっていないスレッドへの返信も not_addressed', () => {
      const result = gate(inChannel({ threadTs: '150.0' }), withChannels, selfBotUserId, new EventDedupe(), undefined, () => false);
      expect(result).toEqual({ kind: 'drop', reason: 'not_addressed' });
    });

    it('関わっているスレッドへの返信はメンション無しでも受け付ける', () => {
      const seen: string[] = [];
      const result = gate(inChannel({ threadTs: '150.0' }), withChannels, selfBotUserId, new EventDedupe(), undefined, (c, t) => {
        seen.push(`${c}:${t}`);
        return true;
      });
      expect(result.kind).toBe('deliver');
      expect(seen).toEqual(['C1:150.0']);
    });

    it('`<@U|name>` の形のメンションも認識して取り除く', () => {
      const result = gate(inChannel({ text: `<@${selfBotUserId}|fox3> do it` }), withChannels, selfBotUserId, new EventDedupe());
      expect(result).toMatchObject({ kind: 'deliver', content: 'do it' });
    });

    it('他の人へのメンションだけでは受け付けない', () => {
      const result = gate(inChannel({ text: '<@U999> hello' }), withChannels, selfBotUserId, new EventDedupe());
      expect(result).toEqual({ kind: 'drop', reason: 'not_addressed' });
    });

    it('メンションだけの投稿は (本文なし) として渡す', () => {
      const result = gate(inChannel({ text: `<@${selfBotUserId}>` }), withChannels, selfBotUserId, new EventDedupe());
      expect(result).toMatchObject({ kind: 'deliver', content: '(本文なし)' });
    });

    it('メンション付きの "yes ID" も回答として扱う', () => {
      const result = gate(inChannel({ text: `<@${selfBotUserId}> yes abcde` }), withChannels, selfBotUserId, new EventDedupe());
      expect(result).toEqual({ kind: 'verdict', verdict: { requestId: 'abcde', behavior: 'allow' } });
    });

    it('DM はメンションが無くても受け付ける（従来どおり）', () => {
      expect(gate(baseMsg(), withChannels, selfBotUserId, new EventDedupe()).kind).toBe('deliver');
    });
  });

  it('drops a channel message whose channel is not in channels', () => {
    const dedupe = new EventDedupe();
    const withChannels = { ...access, channels: ['C1'] };
    const result = gate(baseMsg({ channelType: 'group', channel: 'C2' }), withChannels, selfBotUserId, dedupe);
    expect(result).toEqual({ kind: 'drop', reason: 'channel_not_allowed' });
  });

  it('drops a message in an allowed channel from a user not in allowFrom', () => {
    const dedupe = new EventDedupe();
    const withChannels = { ...access, channels: ['C1'] };
    const result = gate(
      baseMsg({ channelType: 'channel', channel: 'C1', user: 'U999' }),
      withChannels,
      selfBotUserId,
      dedupe
    );
    expect(result).toEqual({ kind: 'drop', reason: 'user_not_allowed' });
  });

  it('drops mpim as not_im even if its channel ID is in channels', () => {
    const dedupe = new EventDedupe();
    const withChannels = { ...access, channels: ['C1'] };
    const result = gate(baseMsg({ channelType: 'mpim', channel: 'C1' }), withChannels, selfBotUserId, dedupe);
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

  it('添付の name / mimetype の引用符・= も _ に置き換える', () => {
    const result = gate(
      baseMsg({
        subtype: 'file_share',
        text: '',
        files: [{ name: `a" b='c'.png`, mimetype: 'image/png" x="1', size: 1 }]
      }),
      access,
      selfBotUserId,
      new EventDedupe()
    );
    expect(result.kind).toBe('deliver');
    if (result.kind === 'deliver') {
      expect(result.meta.attachments).toBe('a_ b__c_.png(image/png_ x__1, 1)');
    }
  });

  it('大量の添付でも attachments は 2000 文字までに収まる', () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ name: `file-${i}-${'n'.repeat(50)}.txt`, mimetype: 'text/plain', size: i }));
    const result = gate(baseMsg({ subtype: 'file_share', text: '', files }), access, selfBotUserId, new EventDedupe());
    expect(result.kind).toBe('deliver');
    if (result.kind === 'deliver') {
      expect(result.meta.attachments?.length).toBe(2000);
      expect(result.meta.attachments?.endsWith('…')).toBe(true);
      expect(result.meta.attachment_count).toBe('100');
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

// --- 現状固定（既知の挙動をそのまま固定する。仕様として望ましいかは別途判断） ---
describe('gate の現状固定', () => {
  it('"yes maybe" は isKnownRequest を省略すると verdict になる（maybe が ID の文字集合に収まるため）', () => {
    const result = gate(baseMsg({ text: 'yes maybe' }), access, selfBotUserId, new EventDedupe());
    expect(result).toEqual({ kind: 'verdict', verdict: { requestId: 'maybe', behavior: 'allow' } });
  });

  it('"yes maybe" は保留中の ID でなければ通常のメッセージとして deliver される', () => {
    const asked: string[] = [];
    const isKnown = (id: string): boolean => {
      asked.push(id);
      return id === 'abcde';
    };
    const result = gate(baseMsg({ text: 'yes maybe' }), access, selfBotUserId, new EventDedupe(), isKnown);
    expect(result.kind).toBe('deliver');
    if (result.kind === 'deliver') expect(result.content).toBe('yes maybe');
    expect(asked).toEqual(['maybe']);

    const known = gate(baseMsg({ text: 'no ABCDE' }), access, selfBotUserId, new EventDedupe(), isKnown);
    expect(known).toEqual({ kind: 'verdict', verdict: { requestId: 'abcde', behavior: 'deny' } });
  });

  it('"Y abcde" は allow の verdict になる（大文字小文字を区別しない）', () => {
    const result = gate(baseMsg({ text: 'Y abcde' }), access, selfBotUserId, new EventDedupe());
    expect(result).toEqual({ kind: 'verdict', verdict: { requestId: 'abcde', behavior: 'allow' } });
  });

  it('前後に空白があっても verdict になる', () => {
    const result = gate(baseMsg({ text: '  no ABCDE \n' }), access, selfBotUserId, new EventDedupe());
    expect(result).toEqual({ kind: 'verdict', verdict: { requestId: 'abcde', behavior: 'deny' } });
  });

  it('空白のみの本文は、そのまま deliver される', () => {
    const result = gate(baseMsg({ text: '   ' }), access, selfBotUserId, new EventDedupe());
    expect(result.kind).toBe('deliver');
    if (result.kind === 'deliver') expect(result.content).toBe('   ');
  });

  it('本文が空で添付が複数なら "(N attachments)" になる', () => {
    const result = gate(
      baseMsg({
        subtype: 'file_share',
        text: '',
        files: [
          { name: 'a.png', mimetype: 'image/png', size: 1 },
          { name: 'b.txt', mimetype: 'text/plain', size: 2 },
        ],
      }),
      access,
      selfBotUserId,
      new EventDedupe()
    );
    expect(result.kind).toBe('deliver');
    if (result.kind === 'deliver') {
      expect(result.content).toBe('(2 attachments)');
      expect(result.meta.attachment_count).toBe('2');
      expect(result.meta.attachments).toBe('a.png(image/png, 1); b.txt(text/plain, 2)');
    }
  });

  it('本文が undefined で添付も無ければ "(attachment)" になる', () => {
    const result = gate(baseMsg({ text: undefined, files: undefined }), access, selfBotUserId, new EventDedupe());
    expect(result.kind).toBe('deliver');
    if (result.kind === 'deliver') {
      expect(result.content).toBe('(attachment)');
      expect('attachment_count' in result.meta).toBe(false);
    }
  });

  it('添付の name / mimetype / size が欠けていても空文字で埋める', () => {
    const result = gate(
      baseMsg({ subtype: 'file_share', text: '', files: [{}] }),
      access,
      selfBotUserId,
      new EventDedupe()
    );
    expect(result.kind).toBe('deliver');
    if (result.kind === 'deliver') expect(result.meta.attachments).toBe('(, )');
  });

  it('eventId が undefined なら重複判定をしない（同じ内容が 2 回とも deliver される）', () => {
    const dedupe = new EventDedupe();
    const first = gate(baseMsg({ eventId: undefined }), access, selfBotUserId, dedupe);
    const second = gate(baseMsg({ eventId: undefined }), access, selfBotUserId, dedupe);
    expect(first.kind).toBe('deliver');
    expect(second.kind).toBe('deliver');
  });

  it('user が空文字なら bot_or_self として drop する', () => {
    const result = gate(baseMsg({ user: '' }), access, selfBotUserId, new EventDedupe());
    expect(result).toEqual({ kind: 'drop', reason: 'bot_or_self' });
  });

  it('user が undefined なら bot_or_self として drop する', () => {
    const result = gate(baseMsg({ user: undefined }), access, selfBotUserId, new EventDedupe());
    expect(result).toEqual({ kind: 'drop', reason: 'bot_or_self' });
  });

  it('userTeam が access の teamId と同じなら通す', () => {
    const result = gate(baseMsg({ userTeam: 'T123' }), access, selfBotUserId, new EventDedupe());
    expect(result.kind).toBe('deliver');
  });

  it('判定順: team → user_team → チャンネル種別 → bot → subtype → allowFrom → メンション/スレッド → dedupe の順で最初に当たった理由になる', () => {
    const dedupe = new EventDedupe();
    // teamId 不一致かつ許可外ユーザー → team_mismatch が先
    expect(gate(baseMsg({ teamId: 'TX', user: 'U999' }), access, selfBotUserId, dedupe)).toEqual({
      kind: 'drop',
      reason: 'team_mismatch',
    });
    // channelType 不一致かつ bot → not_im / channel_not_allowed が先
    expect(gate(baseMsg({ channelType: 'mpim', botId: 'B1' }), access, selfBotUserId, dedupe)).toEqual({
      kind: 'drop',
      reason: 'not_im',
    });
    expect(gate(baseMsg({ channelType: 'channel', botId: 'B1' }), access, selfBotUserId, dedupe)).toEqual({
      kind: 'drop',
      reason: 'channel_not_allowed',
    });
    // subtype 不一致かつ許可外ユーザー → unsupported_subtype が先
    expect(gate(baseMsg({ subtype: 'bot_message', user: 'U999' }), access, selfBotUserId, dedupe)).toEqual({
      kind: 'drop',
      reason: 'unsupported_subtype',
    });
    const withChannels = { ...access, channels: ['C1'] };
    const inChannel = { channelType: 'channel', channel: 'C1' };
    // 許可外ユーザーかつメンション無し → user_not_allowed が先
    expect(gate(baseMsg({ ...inChannel, user: 'U999' }), withChannels, selfBotUserId, dedupe)).toEqual({
      kind: 'drop',
      reason: 'user_not_allowed',
    });
    // メンション無しかつ既出の event_id → not_addressed が先（dedupe には記録しない）
    dedupe.seen('E-dup');
    expect(gate(baseMsg({ ...inChannel, eventId: 'E-dup' }), withChannels, selfBotUserId, dedupe)).toEqual({
      kind: 'drop',
      reason: 'not_addressed',
    });
  });

  it('drop されたイベントは dedupe に記録されない', () => {
    const dedupe = new EventDedupe();
    expect(gate(baseMsg({ eventId: 'X', user: 'U999' }), access, selfBotUserId, dedupe).kind).toBe('drop');
    expect(gate(baseMsg({ eventId: 'X' }), access, selfBotUserId, dedupe).kind).toBe('deliver');
  });
});
