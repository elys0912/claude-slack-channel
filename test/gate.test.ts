import { describe, expect, it } from 'vitest';
import { EventDedupe, gate, parsePermissionReply, type GateResult, type InboundMessage } from '../src/gate.js';
import type { ParsedAccess } from '../src/config.js';

const access: ParsedAccess = { teamId: 'T123', allowFrom: ['U123'] };
const WITH_CHANNELS: ParsedAccess = { ...access, channels: ['C1'] };
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

interface GateOptions {
  access?: ParsedAccess;
  /** 同じ dedupe で続けて判定するときだけ渡す（省略時は毎回新しく作る） */
  dedupe?: EventDedupe;
  isKnown?: (requestId: string) => boolean;
  isEngaged?: (channel: string, threadTs: string) => boolean;
}

/** baseMsg に overrides を重ねて gate にかける。各テストには変える項目だけを書く */
function gateOf(overrides: Partial<InboundMessage> = {}, options: GateOptions = {}): GateResult {
  return gate(
    baseMsg(overrides),
    options.access ?? access,
    selfBotUserId,
    options.dedupe ?? new EventDedupe(),
    options.isKnown,
    options.isEngaged
  );
}

describe('gate', () => {
  it('delivers a DM from an allowed user', () => {
    expect(gateOf()).toMatchObject({
      kind: 'deliver',
      content: 'hello',
      meta: { chat_id: 'D1', message_id: '100.1', thread_ts: '100.1', user_id: 'U123', ts: '100.1' }
    });
  });

  it('drops a message from a user not in allowFrom', () => {
    expect(gateOf({ user: 'U999' })).toEqual({ kind: 'drop', reason: 'user_not_allowed' });
  });

  it('drops when teamId mismatches', () => {
    expect(gateOf({ teamId: 'TOTHER' })).toEqual({ kind: 'drop', reason: 'team_mismatch' });
  });

  it('drops when teamId is undefined', () => {
    expect(gateOf({ teamId: undefined })).toEqual({ kind: 'drop', reason: 'team_mismatch' });
  });

  it('drops when userTeam mismatches (Slack Connect external user)', () => {
    expect(gateOf({ userTeam: 'TEXTERNAL' })).toEqual({ kind: 'drop', reason: 'user_team_mismatch' });
  });

  it('drops channelType "channel" when channels is not configured', () => {
    expect(gateOf({ channelType: 'channel', channel: 'C1' })).toEqual({ kind: 'drop', reason: 'channel_not_allowed' });
  });

  it.each(['channel', 'group'])('delivers a "%s" message when the channel is in channels', (channelType) => {
    const result = gateOf(
      { channelType, channel: 'C1', ts: '200.1', threadTs: '150.0', text: `<@${selfBotUserId}> hello` },
      { access: WITH_CHANNELS }
    );
    expect(result).toMatchObject({ kind: 'deliver', content: 'hello', meta: { chat_id: 'C1', thread_ts: '150.0' } });
  });

  describe('チャンネルではメンションか、ボットが関わるスレッドへの返信だけ受け付ける', () => {
    const inChannel = (overrides: Partial<InboundMessage> = {}, options: GateOptions = {}): GateResult =>
      gateOf({ channelType: 'channel', channel: 'C1', ts: '200.1', ...overrides }, { access: WITH_CHANNELS, ...options });

    it('メンションもスレッドも無ければ not_addressed', () => {
      expect(inChannel()).toEqual({ kind: 'drop', reason: 'not_addressed' });
    });

    it('関わっていないスレッドへの返信も not_addressed', () => {
      const result = inChannel({ threadTs: '150.0' }, { isEngaged: () => false });
      expect(result).toEqual({ kind: 'drop', reason: 'not_addressed' });
    });

    it('関わっているスレッドへの返信はメンション無しでも受け付ける', () => {
      const seen: string[] = [];
      const isEngaged = (c: string, t: string): boolean => {
        seen.push(`${c}:${t}`);
        return true;
      };
      const result = inChannel({ threadTs: '150.0' }, { isEngaged });
      expect(result.kind).toBe('deliver');
      expect(seen).toEqual(['C1:150.0']);
    });

    it('`<@U|name>` の形のメンションも認識して取り除く', () => {
      expect(inChannel({ text: `<@${selfBotUserId}|fox3> do it` })).toMatchObject({ kind: 'deliver', content: 'do it' });
    });

    it('他の人へのメンションだけでは受け付けない', () => {
      expect(inChannel({ text: '<@U999> hello' })).toEqual({ kind: 'drop', reason: 'not_addressed' });
    });

    it('メンションだけの投稿は (本文なし) として渡す', () => {
      expect(inChannel({ text: `<@${selfBotUserId}>` })).toMatchObject({ kind: 'deliver', content: '(本文なし)' });
    });

    it('メンション付きの "yes ID" も回答として扱う', () => {
      expect(inChannel({ text: `<@${selfBotUserId}> yes abcde` })).toEqual({
        kind: 'verdict',
        verdict: { requestId: 'abcde', behavior: 'allow' }
      });
    });

    it('DM はメンションが無くても受け付ける（従来どおり）', () => {
      expect(gateOf({}, { access: WITH_CHANNELS }).kind).toBe('deliver');
    });
  });

  it('drops a channel message whose channel is not in channels', () => {
    const result = gateOf({ channelType: 'group', channel: 'C2' }, { access: WITH_CHANNELS });
    expect(result).toEqual({ kind: 'drop', reason: 'channel_not_allowed' });
  });

  it('drops a message in an allowed channel from a user not in allowFrom', () => {
    const result = gateOf({ channelType: 'channel', channel: 'C1', user: 'U999' }, { access: WITH_CHANNELS });
    expect(result).toEqual({ kind: 'drop', reason: 'user_not_allowed' });
  });

  it.each([
    { label: 'channels が無い', accessOf: access },
    { label: 'チャンネル ID が channels にある', accessOf: WITH_CHANNELS }
  ])('drops channelType "mpim" as not_im ($label)', ({ accessOf }) => {
    expect(gateOf({ channelType: 'mpim', channel: 'C1' }, { access: accessOf })).toEqual({ kind: 'drop', reason: 'not_im' });
  });

  it('drops when botId is present', () => {
    expect(gateOf({ botId: 'B1' })).toEqual({ kind: 'drop', reason: 'bot_or_self' });
  });

  it('drops messages from the bot itself', () => {
    expect(gateOf({ user: selfBotUserId })).toEqual({ kind: 'drop', reason: 'bot_or_self' });
  });

  it('drops subtype message_changed', () => {
    expect(gateOf({ subtype: 'message_changed' })).toEqual({ kind: 'drop', reason: 'unsupported_subtype' });
  });

  it('添付の ID を attachment_ids にカンマ区切りで載せる（ID の無いものは飛ばす）', () => {
    const result = gateOf({
      subtype: 'file_share',
      text: '',
      files: [{ id: 'F1AAA', name: 'a.zip' }, { name: 'b' }, { id: 'F2BBB', name: 'c' }]
    });
    expect(result).toMatchObject({ kind: 'deliver', meta: { attachment_ids: 'F1AAA,F2BBB' } });
  });

  it('スレッドへの返信を「チャンネル（DM）にも送る」で投稿したもの（thread_broadcast）も届ける', () => {
    expect(gateOf({ subtype: 'thread_broadcast', text: '続けて' }).kind).toBe('deliver');
  });

  it('delivers subtype file_share', () => {
    const result = gateOf({ subtype: 'file_share', text: '', files: [{ name: 'a.png', mimetype: 'image/png', size: 100 }] });
    expect(result.kind).toBe('deliver');
  });

  it('drops the second occurrence of the same eventId', () => {
    const dedupe = new EventDedupe();
    const first = gateOf({ eventId: 'DUP' }, { dedupe });
    const second = gateOf({ eventId: 'DUP' }, { dedupe });
    expect(first.kind).toBe('deliver');
    expect(second).toEqual({ kind: 'drop', reason: 'duplicate_event' });
  });

  // 返信の文字列の解釈の細部は parsePermissionReply の describe で確かめる
  it('"yes ABCDE" の形の本文は verdict になる', () => {
    expect(gateOf({ text: 'yes ABCDE' })).toEqual({ kind: 'verdict', verdict: { requestId: 'abcde', behavior: 'allow' } });
  });

  it('uses (attachment) placeholder when text is empty and one file is present', () => {
    const result = gateOf({
      subtype: 'file_share',
      text: '',
      files: [{ name: 'evil;name<tag>\r\n.png', mimetype: 'image/png', size: 42 }]
    });
    expect(result).toMatchObject({
      kind: 'deliver',
      content: '(attachment)',
      meta: {
        attachment_count: '1',
        attachments: expect.stringContaining('evil_name_tag___.png')
      }
    });
    expect(result).toHaveProperty('meta.attachments', expect.not.stringMatching(/[;\r\n<>]/));
  });

  it('添付の name / mimetype の引用符・= も _ に置き換える', () => {
    const result = gateOf({
      subtype: 'file_share',
      text: '',
      files: [{ name: `a" b='c'.png`, mimetype: 'image/png" x="1', size: 1 }]
    });
    expect(result).toMatchObject({ kind: 'deliver', meta: { attachments: 'a_ b__c_.png(image/png_ x__1, 1)' } });
  });

  it('大量の添付でも attachments は 2000 文字までに収まる', () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ name: `file-${i}-${'n'.repeat(50)}.txt`, mimetype: 'text/plain', size: i }));
    const result = gateOf({ subtype: 'file_share', text: '', files });
    expect(result).toMatchObject({
      kind: 'deliver',
      meta: { attachment_count: '100', attachments: expect.stringMatching(/…$/) }
    });
    expect(result).toHaveProperty('meta.attachments.length', 2000);
  });

  it('does not include undefined-valued keys in meta', () => {
    const result = gateOf({ channel: undefined });
    expect(result.kind).toBe('deliver');
    expect(result).not.toHaveProperty('meta.chat_id');
  });

  it('defaults thread_ts to ts when threadTs is undefined', () => {
    const result = gateOf({ ts: '200.2', threadTs: undefined });
    expect(result).toMatchObject({ kind: 'deliver', meta: { thread_ts: '200.2' } });
  });

  it('keeps thread_ts when threadTs is provided', () => {
    const result = gateOf({ ts: '200.2', threadTs: '199.0' });
    expect(result).toMatchObject({ kind: 'deliver', meta: { thread_ts: '199.0' } });
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

  it('parses "yes ABCDE" as allow with lowercased id', () => {
    expect(parsePermissionReply('yes ABCDE')).toEqual({ requestId: 'abcde', behavior: 'allow' });
  });

  it('parses uppercase YES', () => {
    expect(parsePermissionReply('YES abcde')).toEqual({ requestId: 'abcde', behavior: 'allow' });
  });

  it('parses "n abcde" as deny', () => {
    expect(parsePermissionReply('n abcde')).toEqual({ requestId: 'abcde', behavior: 'deny' });
  });

  it('ID が 5 文字でなければ（4 文字・6 文字）null を返す', () => {
    expect(parsePermissionReply('yes abcd')).toBeNull();
    expect(parsePermissionReply('yes abcdef')).toBeNull();
  });

  it('rejects "yes abcdl" (contains l)', () => {
    expect(parsePermissionReply('yes abcdl')).toBeNull();
  });

  it('rejects "yes" alone', () => {
    expect(parsePermissionReply('yes')).toBeNull();
  });

  it('rejects "please yes abcde" (not anchored)', () => {
    expect(parsePermissionReply('please yes abcde')).toBeNull();
  });
});

// --- 現状固定（既知の挙動をそのまま固定する。仕様として望ましいかは別途判断） ---
describe('parsePermissionReply の現状固定', () => {
  it('"Y abcde" は allow になる（大文字小文字を区別しない）', () => {
    expect(parsePermissionReply('Y abcde')).toEqual({ requestId: 'abcde', behavior: 'allow' });
  });

  it('前後に空白があっても deny として解釈する', () => {
    expect(parsePermissionReply('  no ABCDE \n')).toEqual({ requestId: 'abcde', behavior: 'deny' });
  });
});

describe('gate の現状固定', () => {
  it('"yes maybe" は isKnownRequest を省略すると verdict になる（maybe が ID の文字集合に収まるため）', () => {
    expect(gateOf({ text: 'yes maybe' })).toEqual({ kind: 'verdict', verdict: { requestId: 'maybe', behavior: 'allow' } });
  });

  describe('isKnownRequest を渡したとき', () => {
    const isKnownOnly =
      (asked: string[]) =>
      (id: string): boolean => {
        asked.push(id);
        return id === 'abcde';
      };

    it('"yes maybe" は保留中の ID でなければ通常のメッセージとして deliver される', () => {
      const asked: string[] = [];
      const result = gateOf({ text: 'yes maybe' }, { isKnown: isKnownOnly(asked) });
      expect(result).toMatchObject({ kind: 'deliver', content: 'yes maybe' });
      expect(asked).toEqual(['maybe']);
    });

    it('保留中の ID への回答は verdict になる', () => {
      const result = gateOf({ text: 'no ABCDE' }, { isKnown: isKnownOnly([]) });
      expect(result).toEqual({ kind: 'verdict', verdict: { requestId: 'abcde', behavior: 'deny' } });
    });
  });

  it('空白のみの本文は、そのまま deliver される', () => {
    expect(gateOf({ text: '   ' })).toMatchObject({ kind: 'deliver', content: '   ' });
  });

  it('本文が空で添付が複数なら "(N attachments)" になる', () => {
    const result = gateOf({
      subtype: 'file_share',
      text: '',
      files: [
        { name: 'a.png', mimetype: 'image/png', size: 1 },
        { name: 'b.txt', mimetype: 'text/plain', size: 2 },
      ],
    });
    expect(result).toMatchObject({
      kind: 'deliver',
      content: '(2 attachments)',
      meta: { attachment_count: '2', attachments: 'a.png(image/png, 1); b.txt(text/plain, 2)' }
    });
  });

  it('本文が undefined で添付も無ければ "(attachment)" になる', () => {
    const result = gateOf({ text: undefined, files: undefined });
    expect(result).toMatchObject({ kind: 'deliver', content: '(attachment)' });
    expect(result).not.toHaveProperty('meta.attachment_count');
  });

  it('添付の name / mimetype / size が欠けていても空文字で埋める', () => {
    const result = gateOf({ subtype: 'file_share', text: '', files: [{}] });
    expect(result).toMatchObject({ kind: 'deliver', meta: { attachments: '(, )' } });
  });

  it('eventId が undefined なら重複判定をしない（同じ内容が 2 回とも deliver される）', () => {
    const dedupe = new EventDedupe();
    const first = gateOf({ eventId: undefined }, { dedupe });
    const second = gateOf({ eventId: undefined }, { dedupe });
    expect(first.kind).toBe('deliver');
    expect(second.kind).toBe('deliver');
  });

  it('user が空文字なら bot_or_self として drop する', () => {
    expect(gateOf({ user: '' })).toEqual({ kind: 'drop', reason: 'bot_or_self' });
  });

  it('user が undefined なら bot_or_self として drop する', () => {
    expect(gateOf({ user: undefined })).toEqual({ kind: 'drop', reason: 'bot_or_self' });
  });

  it('userTeam が access の teamId と同じなら通す', () => {
    expect(gateOf({ userTeam: 'T123' }).kind).toBe('deliver');
  });

  describe('判定順: team → user_team → チャンネル種別 → bot → subtype → allowFrom → メンション/スレッド → dedupe の順で最初に当たった理由になる', () => {
    const inChannel = { channelType: 'channel', channel: 'C1' };

    it.each([
      { label: 'teamId 不一致かつ許可外ユーザー → team_mismatch が先', overrides: { teamId: 'TX', user: 'U999' }, accessOf: access, reason: 'team_mismatch' },
      { label: 'mpim かつ bot → not_im が先', overrides: { channelType: 'mpim', botId: 'B1' }, accessOf: access, reason: 'not_im' },
      { label: '許可外のチャンネルかつ bot → channel_not_allowed が先', overrides: { channelType: 'channel', botId: 'B1' }, accessOf: access, reason: 'channel_not_allowed' },
      { label: 'subtype 不一致かつ許可外ユーザー → unsupported_subtype が先', overrides: { subtype: 'bot_message', user: 'U999' }, accessOf: access, reason: 'unsupported_subtype' },
      { label: '許可外ユーザーかつメンション無し → user_not_allowed が先', overrides: { ...inChannel, user: 'U999' }, accessOf: WITH_CHANNELS, reason: 'user_not_allowed' },
    ])('$label', ({ overrides, accessOf, reason }) => {
      expect(gateOf(overrides, { access: accessOf })).toEqual({ kind: 'drop', reason });
    });

    it('メンション無しかつ既出の event_id → not_addressed が先（dedupe には記録しない）', () => {
      const dedupe = new EventDedupe();
      dedupe.seen('E-dup');
      const result = gateOf({ ...inChannel, eventId: 'E-dup' }, { access: WITH_CHANNELS, dedupe });
      expect(result).toEqual({ kind: 'drop', reason: 'not_addressed' });
    });
  });

  it('drop されたイベントは dedupe に記録されない', () => {
    const dedupe = new EventDedupe();
    expect(gateOf({ eventId: 'X', user: 'U999' }, { dedupe }).kind).toBe('drop');
    expect(gateOf({ eventId: 'X' }, { dedupe }).kind).toBe('deliver');
  });
});
