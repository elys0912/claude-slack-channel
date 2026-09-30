import { describe, expect, it } from 'vitest';
import { META_VALUE_MAX, escapeMrkdwn, neutralizeBroadcasts, sanitizeMeta } from '../src/format.js';

describe('neutralizeBroadcasts', () => {
  it('neutralizes <!channel>', () => {
    expect(neutralizeBroadcasts('<!channel>')).toBe('@​channel');
  });

  it('neutralizes <!here|here>', () => {
    // <!here|here> のような label 付き形式は subteam 以外では通常使われないが
    // <!here> 単体（label なし）は必ず無効化されることを確認する
    expect(neutralizeBroadcasts('<!here>')).toBe('@​here');
  });

  it('neutralizes <!everyone>', () => {
    expect(neutralizeBroadcasts('<!everyone>')).toBe('@​everyone');
  });

  it('neutralizes <!subteam^S123>', () => {
    const result = neutralizeBroadcasts('<!subteam^S123>');
    expect(result).not.toContain('<!subteam');
    expect(result).toContain('​');
  });

  it('neutralizes <!subteam^S123|label>', () => {
    const result = neutralizeBroadcasts('<!subteam^S123|eng-team>');
    expect(result).not.toContain('<!subteam');
    expect(result).toContain('​');
  });

  it('neutralizes bare @here', () => {
    expect(neutralizeBroadcasts('hi @here please')).toBe('hi @​here please');
  });

  it('neutralizes bare @channel and @everyone', () => {
    expect(neutralizeBroadcasts('@channel @everyone')).toBe('@​channel @​everyone');
  });

  it('leaves normal text and normal mentions alone', () => {
    expect(neutralizeBroadcasts('hello <@U123> world')).toBe('hello <@U123> world');
  });

  it('does not double-process already neutralized text', () => {
    const once = neutralizeBroadcasts('<!channel>');
    const twice = neutralizeBroadcasts(once);
    expect(twice).toBe(once);
  });
});

describe('escapeMrkdwn', () => {
  it('escapes & < >', () => {
    expect(escapeMrkdwn('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('escapes & before other entities are introduced', () => {
    expect(escapeMrkdwn('<')).toBe('&lt;');
    expect(escapeMrkdwn('&lt;')).toBe('&amp;lt;');
  });

  it('leaves plain text untouched', () => {
    expect(escapeMrkdwn('hello world')).toBe('hello world');
  });
});

describe('sanitizeMeta', () => {
  it('drops undefined values', () => {
    expect(sanitizeMeta({ a: '1', b: undefined })).toEqual({ a: '1' });
  });

  it('drops keys with invalid characters', () => {
    expect(sanitizeMeta({ 'a-b': '1', valid_key: '2', 'c.d': '3' })).toEqual({ valid_key: '2' });
  });

  it('keeps keys with letters, numbers, underscore', () => {
    expect(sanitizeMeta({ Chat_ID2: 'x' })).toEqual({ Chat_ID2: 'x' });
  });

  it('returns empty object for empty input', () => {
    expect(sanitizeMeta({})).toEqual({});
  });

  it('値は META_VALUE_MAX 文字までに切り詰め、末尾を … にする', () => {
    expect(META_VALUE_MAX).toBe(2000);
    const out = sanitizeMeta({ ok: 'x'.repeat(2000), long: 'y'.repeat(2001) });
    expect(out.ok).toBe('x'.repeat(2000));
    expect(out.long).toBe('y'.repeat(1999) + '…');
  });
});
