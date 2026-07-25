import { describe, expect, it } from 'vitest';
import { buildForbiddenHomeView, buildHomeView, formatTime } from '../src/home.js';
import type { HomeState } from '../src/home.js';

const base: HomeState = {
  running: true,
  since: new Date(2026, 8, 30, 21, 5),
  workDir: 'C:\\dev',
  channelCount: 3,
  ruleCount: 2,
  replyTimeoutMin: 5,
  now: new Date(2026, 8, 30, 21, 10),
};

function text(view: unknown): string {
  return JSON.stringify(view);
}

describe('buildHomeView', () => {
  it('稼働中なら起動時刻・作業フォルダー・チャンネル数・ルール数・使い方を出す', () => {
    const view = buildHomeView(base) as { type: string };
    expect(view.type).toBe('home');
    const t = text(view);
    expect(t).toContain('稼働中');
    expect(t).toContain('2026-09-30 21:05 から');
    expect(t).toContain('C:\\\\dev');
    expect(t).toContain('許可したチャンネル 3 件');
    expect(t).toContain('ルール*: 2 件');
    expect(t).toContain('!screen');
    expect(t).toContain('5 分返事が無いとき');
    expect(t).toContain('最終更新 2026-09-30 21:10');
  });

  it('停止中なら停止時刻と、起動し直せば使える旨を出す', () => {
    const t = text(buildHomeView({ ...base, running: false }));
    expect(t).toContain('停止中');
    expect(t).toContain('21:05 に停止');
    expect(t).not.toContain('稼働中');
  });

  it('チャンネルが無ければ DM だけ、ルールが使えなければ行を出さない、警告が無効なら出さない', () => {
    const t = text(buildHomeView({ ...base, channelCount: 0, ruleCount: undefined, replyTimeoutMin: 0 }));
    expect(t).toContain('DM だけ');
    expect(t).not.toContain('足したルール*');
    expect(t).not.toContain('返事が無いとき');
  });

  it('使い方のメンションはボット自身の ID で出し、アプリ名は埋め込まない', () => {
    const t = text(buildHomeView({ ...base, botUserId: 'U0C3MSN3MND' }));
    expect(t).toContain('<@U0C3MSN3MND> にメンションする');
    expect(t).not.toContain('fox3-local');
    expect(t).not.toContain('FOX3 Local Bridge');
  });

  it('ボットの ID が分からない・形が違うときは「ボット」と書く', () => {
    expect(text(buildHomeView(base))).toContain('チャンネルで ボット にメンションする');
    expect(text(buildHomeView({ ...base, botUserId: '<!here>' }))).toContain('チャンネルで ボット にメンションする');
  });

  it('作業フォルダーの & < > はエスケープする', () => {
    expect(text(buildHomeView({ ...base, workDir: 'C:\\a<b>&c' }))).toContain('a&lt;b&gt;&amp;c');
  });
});

describe('buildHomeView（home.json で差し替え）', () => {
  const custom = {
    header: '📣 カスタムの見出し',
    running: '{since} から稼働中',
    stopped: '今は停止中',
    greetings: ['一つ目', '二つ目 {mention}', '三つ目'],
    body: ['本文の1行目', '本文の2行目'],
    footer: 'フッター',
  };

  it('見出し・ひと言・本文・フッターを差し替え、{since} と {mention} を置き換える', () => {
    const t = text(buildHomeView({ ...base, botUserId: 'UBOT1', custom, random: () => 0.5 }));
    expect(t).toContain('カスタムの見出し');
    expect(t).toContain('2026-09-30 21:05 から稼働中');
    expect(t).toContain('二つ目 <@UBOT1>');
    expect(t).toContain('本文の1行目\\n本文の2行目');
    expect(t).toContain('フッター ・ 最終更新 2026-09-30 21:10');
    // body を書いたら既定の情報と使い方は出さない
    expect(t).not.toContain('作業フォルダー');
    expect(t).not.toContain('*使い方*');
  });

  it('greetings は乱数で 1 つだけ選ぶ', () => {
    const t0 = text(buildHomeView({ ...base, custom, random: () => 0 }));
    const t2 = text(buildHomeView({ ...base, custom, random: () => 0.99 }));
    expect(t0).toContain('一つ目');
    expect(t0).not.toContain('三つ目');
    expect(t2).toContain('三つ目');
  });

  it('停止中は stopped を出す', () => {
    const t = text(buildHomeView({ ...base, running: false, custom }));
    expect(t).toContain('停止中');
    expect(t).toContain('今は停止中');
  });

  it('body を書かなければ既定の情報と使い方を残す', () => {
    const t = text(buildHomeView({ ...base, custom: { greetings: ['こんにちは'] }, random: () => 0 }));
    expect(t).toContain('こんにちは');
    expect(t).toContain('作業フォルダー');
    expect(t).toContain('*使い方*');
  });
});

describe('buildForbiddenHomeView', () => {
  it('中の情報は出さない', () => {
    const t = text(buildForbiddenHomeView());
    expect(t).toContain('許可されたメンバーだけ');
    expect(t).not.toContain('作業フォルダー');
  });
});

describe('formatTime', () => {
  it('ゼロ埋めする', () => {
    expect(formatTime(new Date(2026, 0, 2, 3, 4))).toBe('2026-01-02 03:04');
  });
});
