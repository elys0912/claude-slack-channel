// Slack のアプリのホームタブに出す画面（Block Kit の view）を組み立てる純関数群（I/O なし）
import { escapeMrkdwn } from './format.js';

export interface HomeState {
  /** 稼働中なら起動時刻、停止中なら停止時刻 */
  running: boolean;
  since: Date;
  /** Claude Code の作業フォルダー */
  workDir: string;
  /** access.json の channels の件数 */
  channelCount: number;
  /** 「今後も許可」で足したルールの件数（使えないなら undefined） */
  ruleCount: number | undefined;
  /** 無応答の警告までの分数（0 なら無効） */
  replyTimeoutMin: number;
  /** ホームの表示を更新した時刻 */
  now: Date;
}

/** `2026-09-30 21:05` の形（実行している PC のタイムゾーン） */
export function formatTime(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function section(text: string): unknown {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function context(text: string): unknown {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

const HEADER = { type: 'header', text: { type: 'plain_text', text: '🦊 FOX3 Local Bridge', emoji: true } };

/** 許可ユーザーに見せるホーム（稼働中・停止中） */
export function buildHomeView(state: HomeState): unknown {
  const status = state.running
    ? `🟢 *稼働中*（${formatTime(state.since)} から）`
    : `⏸ *停止中*（${formatTime(state.since)} に停止）\n手元でセッションを起動すれば、また使えるようになるわ。`;

  const blocks: unknown[] = [
    HEADER,
    section(status),
    section(
      [
        `*作業フォルダー*: \`${escapeMrkdwn(state.workDir)}\``,
        `*話しかけられる場所*: DM${state.channelCount > 0 ? ` と、許可したチャンネル ${state.channelCount} 件` : ' だけ'}`,
        state.ruleCount === undefined ? undefined : `*「今後も許可」で足したルール*: ${state.ruleCount} 件`,
      ]
        .filter((l): l is string => l !== undefined)
        .join('\n')
    ),
    { type: 'divider' },
    section(
      [
        '*使い方*',
        '• DM で話しかけるか、許可したチャンネルで @fox3-local にメンションする。スレッドの続きはメンション無しでいい',
        '• 返事は元のメッセージのスレッドに返す。届いたら 👀 を付ける',
        '• 確認が要る操作は、スレッドに *Allow* / *♾ 今後も許可* / *Deny* のボタンで出す',
        '• `!screen` でターミナルの画面を確認できる。選択画面で止まっていたらボタンで選べる',
        '• `!rules` で「今後も許可」で足したルールを一覧・削除できる',
        state.replyTimeoutMin > 0
          ? `• ${state.replyTimeoutMin} 分返事が無いときは、スレッドに警告を出す`
          : undefined,
      ]
        .filter((l): l is string => l !== undefined)
        .join('\n')
    ),
    context(`最終更新 ${formatTime(state.now)}`),
  ];
  return { type: 'home', blocks };
}

/** 許可ユーザー以外に見せるホーム（中の情報は出さない） */
export function buildForbiddenHomeView(): unknown {
  return {
    type: 'home',
    blocks: [HEADER, section('このアプリは、許可されたメンバーだけが使える手元の開発用ブリッジよ。')],
  };
}
