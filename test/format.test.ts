import { describe, expect, it } from 'vitest';
import { META_VALUE_MAX, escapeMrkdwn, linkifyMarkdownUrls, neutralizeBroadcasts, sanitizeMeta } from '../src/format.js';

// 一斉通知を無効化するために @ の直後へ挟むゼロ幅スペース（見た目では区別できないので名前で書く）
const ZWSP = '\u200b';

describe('neutralizeBroadcasts', () => {
  it('neutralizes <!channel>', () => {
    expect(neutralizeBroadcasts('<!channel>')).toBe(`@${ZWSP}channel`);
  });

  it('neutralizes <!here>', () => {
    expect(neutralizeBroadcasts('<!here>')).toBe(`@${ZWSP}here`);
  });

  it('ラベル付きの <!here|here> / <!channel|channel> / <!everyone|x> も無効化する', () => {
    expect(neutralizeBroadcasts('<!here|here>')).toBe(`@${ZWSP}here`);
    expect(neutralizeBroadcasts('a <!channel|channel> b')).toBe(`a @${ZWSP}channel b`);
    expect(neutralizeBroadcasts('<!everyone|x>')).toBe(`@${ZWSP}everyone`);
  });

  it('neutralizes <!everyone>', () => {
    expect(neutralizeBroadcasts('<!everyone>')).toBe(`@${ZWSP}everyone`);
  });

  it('neutralizes <!subteam^S123>', () => {
    const result = neutralizeBroadcasts('<!subteam^S123>');
    expect(result).not.toContain('<!subteam');
    expect(result).toContain(ZWSP);
  });

  it('neutralizes <!subteam^S123|label>', () => {
    const result = neutralizeBroadcasts('<!subteam^S123|eng-team>');
    expect(result).not.toContain('<!subteam');
    expect(result).toContain(ZWSP);
  });

  it('neutralizes bare @here', () => {
    expect(neutralizeBroadcasts('hi @here please')).toBe(`hi @${ZWSP}here please`);
  });

  it('neutralizes bare @channel and @everyone', () => {
    expect(neutralizeBroadcasts('@channel @everyone')).toBe(`@${ZWSP}channel @${ZWSP}everyone`);
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
    const out = sanitizeMeta({ ok: 'x'.repeat(META_VALUE_MAX), long: 'y'.repeat(META_VALUE_MAX + 1) });
    expect(out.ok).toBe('x'.repeat(META_VALUE_MAX));
    // 末尾の … の 1 文字ぶん本文を削る
    expect(out.long).toBe('y'.repeat(META_VALUE_MAX - 1) + '…');
  });

  it('切り詰めの境目がサロゲートペアの途中なら、その 1 文字ごと落とす', () => {
    // 本文として残せる META_VALUE_MAX - 1 文字目がサロゲートペアの前半に当たる長さ
    const plainLength = META_VALUE_MAX - 2;
    const out = sanitizeMeta({ emoji: 'x'.repeat(plainLength) + '😀😀' });
    expect(out.emoji).toBe('x'.repeat(plainLength) + '…');
    expect(out.emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('linkifyMarkdownUrls', () => {
  it('生の URL を [URL](URL) にする', () => {
    expect(linkifyMarkdownUrls('見て https://example.com/a?b=1 ね')).toBe('見て [https://example.com/a?b=1](https://example.com/a?b=1) ね');
  });

  it('全角の記号の直後・直前でも URL だけを切り出す', () => {
    expect(linkifyMarkdownUrls('こっちよ：https://claude.ai/artifact/AbC123）。')).toBe(
      'こっちよ：[https://claude.ai/artifact/AbC123](https://claude.ai/artifact/AbC123)）。',
    );
  });

  it('末尾の句読点は URL に含めない', () => {
    expect(linkifyMarkdownUrls('see https://example.com/x.')).toBe('see [https://example.com/x](https://example.com/x).');
    expect(linkifyMarkdownUrls('https://example.com, next')).toBe('[https://example.com](https://example.com), next');
  });

  it('リンクの文字の _ や * はエスケープする', () => {
    expect(linkifyMarkdownUrls('https://example.com/a_b_c')).toBe('[https://example.com/a\\_b\\_c](https://example.com/a_b_c)');
  });

  it('mrkdwn の <URL> と <URL|文字> を markdown のリンクにする', () => {
    expect(linkifyMarkdownUrls('<https://example.com>')).toBe('[https://example.com](https://example.com)');
    expect(linkifyMarkdownUrls('<https://example.com|報告>')).toBe('[報告](https://example.com)');
  });

  it('もう [文字](URL) のものは触らない', () => {
    const md = '詳細：[夜の報告](https://claude.ai/artifact/AbC123)';
    expect(linkifyMarkdownUrls(md)).toBe(md);
  });

  it('インラインコードとフェンスのコードの中は触らない', () => {
    const inline = '`curl https://example.com` を叩く';
    expect(linkifyMarkdownUrls(inline)).toBe(inline);
    const fence = '```\ncurl https://example.com\n```\nhttps://example.com';
    expect(linkifyMarkdownUrls(fence)).toBe('```\ncurl https://example.com\n```\n[https://example.com](https://example.com)');
  });

  it('閉じていないフェンスの後ろも触らない', () => {
    const open = '```\nhttps://example.com';
    expect(linkifyMarkdownUrls(open)).toBe(open);
  });

  it('URL の無い文と、中身の無い https:// はそのまま', () => {
    expect(linkifyMarkdownUrls('URL は無いわ')).toBe('URL は無いわ');
    expect(linkifyMarkdownUrls('https:// だけ')).toBe('https:// だけ');
  });
});
