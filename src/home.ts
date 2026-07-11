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
  /** ボット自身の user ID。使い方の説明でメンションとして表示する（分からなければ「ボット」と書く） */
  botUserId?: string | undefined;
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

/** ボットのメンション（ID の形でなければ「ボット」）。アプリ名が違う複数のセッションで同じ文面を使うため、名前は埋め込まない */
function botMention(botUserId: string | undefined): string {
  return botUserId !== undefined && /^[UW][A-Z0-9]{2,}$/.test(botUserId) ? `<@${botUserId}>` : 'ボット';
}

// 見出しはアプリ名に依存しない文言にする（Slack のアプリ名はホームの上部に別に表示される）。
// ボットは高倉クルミ（FOX3）として話すので、ホームの文面もその口調にする
const HEADER = { type: 'header', text: { type: 'plain_text', text: '🦊 先頭は私が行くわ', emoji: true } };

/** 許可ユーザーに見せるホーム（稼働中・停止中） */
export function buildHomeView(state: HomeState): unknown {
  const status = state.running
    ? `🟢 *稼働中*（${formatTime(state.since)} から）\n配置についてるわ。周辺の警戒は済ませてあるから、いつでも来なさい。`
    : `⏸ *停止中*（${formatTime(state.since)} に停止）\n今は撤収中よ。手元でセッションを起動すれば、すぐ配置に戻るから。`;

  const blocks: unknown[] = [
    HEADER,
    section(status),
    section(
      [
        `*作業フォルダー*: \`${escapeMrkdwn(state.workDir)}\`（ここが私の担当エリアよ）`,
        `*話しかけられる場所*: DM${state.channelCount > 0 ? ` と、許可したチャンネル ${state.channelCount} 件` : ' だけ'}`,
        state.ruleCount === undefined
          ? undefined
          : `*「今後も許可」で足したルール*: ${state.ruleCount} 件（増やしすぎないでよね）`,
      ]
        .filter((l): l is string => l !== undefined)
        .join('\n')
    ),
    { type: 'divider' },
    section(
      [
        '*ブリーフィング ―― ちゃんと聞いてよね*',
        `• DM で話しかけるか、許可したチャンネルで ${botMention(state.botUserId)} にメンションして。スレッドの続きはメンション無しでいいわ`,
        '• 返事は元のメッセージのスレッドに返すわ。届いたら 👀 を付けるから、見逃さないでよね',
        '• 確認が要る操作は、スレッドに *Allow* / *♾ 今後も許可* / *Deny* のボタンで聞くわ。撤退不能な操作もあるんだから、ちゃんと読んでから押しなさいよ',
        '• 私が黙り込んだら `!screen` で画面を確認して。選択画面で止まってたら、ボタンで選べるわ',
        '• `!rules` で「今後も許可」で足したルールを一覧・削除できるわ',
        state.replyTimeoutMin > 0
          ? `• ${state.replyTimeoutMin} 分返事が無いときは、スレッドに警告を出すわ。……べ、別にサボってるわけじゃないんだから！`
          : undefined,
      ]
        .filter((l): l is string => l !== undefined)
        .join('\n')
    ),
    context(`最終更新 ${formatTime(state.now)} ・ 時刻が古すぎたら、念のため手元を確認して`),
  ];
  return { type: 'home', blocks };
}

/** 許可ユーザー以外に見せるホーム（中の情報は出さない） */
export function buildForbiddenHomeView(): unknown {
  return {
    type: 'home',
    blocks: [
      HEADER,
      section('ここは許可されたメンバーだけの作戦区域よ。関係者以外は立ち入り禁止なんだから。'),
    ],
  };
}
