// Slack のアプリのホームタブに出す画面（Block Kit の view）を組み立てる純関数群（I/O なし）
import type { ParsedHomeCustom } from './config.js';
import { escapeMrkdwn } from './format.js';
import { clip, formatTime } from './text.js';

// Slack の上限。clip で収め、サロゲートペアの途中では切らない
/** header の plain_text の上限 */
const HEADER_TEXT_MAX = 150;
/** section・context の mrkdwn の上限 */
const SECTION_TEXT_MAX = 3000;

export interface HomeState {
  /** 稼働中か */
  running: boolean;
  /** 稼働中なら起動時刻、停止中なら停止時刻 */
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
  /** 状態ディレクトリの home.json による文面の差し替え（無ければ既定の文面） */
  custom?: HomeCustom | undefined;
  /** greetings から 1 つ選ぶための乱数（0 以上 1 未満）。テスト用の差し替え口 */
  random?: (() => number) | undefined;
}

/**
 * ホームの文面の差し替え。どれも省略でき、省略した部分は既定の文面になる。
 * 文字列の中の `{since}` は起動（停止）時刻、`{mention}` はボットへのメンションに置き換える。
 * body を書くと、既定の「作業フォルダーなどの情報」と「使い方」は出さない。
 * 形は home.json のスキーマ（config.ts の HomeCustomSchema）から作り、定義を 1 か所にする
 */
export type HomeCustom = ParsedHomeCustom;

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
// 既定の文面は中立の常体にする。ボットごとの口調や挨拶は、状態ディレクトリの home.json で差し替える
const HEADER = { type: 'header', text: { type: 'plain_text', text: '🤖 Claude Code ブリッジ', emoji: true } };

/** home.json の文字列の `{since}` / `{mention}` を置き換える */
function fill(text: string, state: HomeState): string {
  return text.replaceAll('{since}', formatTime(state.since)).replaceAll('{mention}', botMention(state.botUserId));
}

/** 稼働中・停止中の 1 行目 */
function statusLabel(state: HomeState): string {
  return state.running
    ? `🟢 *稼働中*（${formatTime(state.since)} から）`
    : `⏸ *停止中*（${formatTime(state.since)} に停止）`;
}

/** home.json で文面を差し替えたホーム */
function buildCustomHomeView(state: HomeState, custom: HomeCustom): unknown {
  const statusNote = state.running ? custom.running : custom.stopped;
  const greetings = custom.greetings ?? [];
  const greeting = greetings.length > 0 ? greetings[randomIndex(state, greetings.length)] : undefined;

  const blocks: unknown[] = [
    custom.header
      ? { type: 'header', text: { type: 'plain_text', text: clip(custom.header, HEADER_TEXT_MAX), emoji: true } }
      : HEADER,
    section(clip([statusLabel(state), statusNote ? fill(statusNote, state) : undefined].filter(Boolean).join('\n'), SECTION_TEXT_MAX)),
  ];
  if (greeting !== undefined) blocks.push(section(clip(`💬 ${fill(greeting, state)}`, SECTION_TEXT_MAX)));
  if (custom.body && custom.body.length > 0) {
    blocks.push({ type: 'divider' }, section(clip(custom.body.map((l) => fill(l, state)).join('\n'), SECTION_TEXT_MAX)));
  } else {
    blocks.push(...defaultDetailBlocks(state));
  }
  const footer = custom.footer ? `${fill(custom.footer, state)} ・ ` : '';
  blocks.push(context(clip(`${footer}最終更新 ${formatTime(state.now)}`, SECTION_TEXT_MAX)));
  return { type: 'home', blocks };
}

/** 0 以上 length 未満の乱数の添字 */
function randomIndex(state: HomeState, length: number): number {
  return Math.floor((state.random ?? Math.random)() * length);
}

/** 許可ユーザーに見せるホーム（稼働中・停止中） */
export function buildHomeView(state: HomeState): unknown {
  if (state.custom) return buildCustomHomeView(state, state.custom);
  const status = state.running
    ? `${statusLabel(state)}\nSlack からの話しかけを受け付けている。`
    : `${statusLabel(state)}\n手元でセッションを起動すると、また受け付けるようになる。`;

  const blocks: unknown[] = [
    HEADER,
    section(status),
    ...defaultDetailBlocks(state),
    context(`最終更新 ${formatTime(state.now)} ・ 時刻が古いときは、ブリッジが強制終了された可能性がある。手元を確かめること`),
  ];
  return { type: 'home', blocks };
}

/** 既定の「作業フォルダーなどの情報」と「使い方」 */
function defaultDetailBlocks(state: HomeState): unknown[] {
  return [
    section(
      [
        `*作業フォルダー*: \`${escapeMrkdwn(state.workDir)}\``,
        `*話しかけられる場所*: DM${state.channelCount > 0 ? ` と、許可したチャンネル ${state.channelCount} 件` : ' だけ'}`,
        state.ruleCount === undefined
          ? undefined
          : `*「今後も許可」で足したルール*: ${state.ruleCount} 件（要らなくなったら \`!rules\` から消せる）`,
      ]
        .filter((l): l is string => l !== undefined)
        .join('\n')
    ),
    { type: 'divider' },
    section(
      [
        '*使い方*',
        `• DM で話しかけるか、許可したチャンネルで ${botMention(state.botUserId)} にメンションする。スレッドの続きはメンション無しで届く`,
        '• 返事は元のメッセージのスレッドに返る。メッセージが届くと 👀 が付く',
        '• 確認が要る操作は、スレッドに *Allow* / *♾ 今後も許可* / *Deny* のボタンで聞く。取り消せない操作もあるので、内容を読んでから押す',
        '• 返事が来ないときは `!screen` で画面を確かめる。選択画面で止まっていれば、ボタンで選べる',
        '• `!rules` で、「今後も許可」で足したルールを一覧・削除できる',
        '• `!help` で、ほかのコマンドの一覧が出る',
        state.replyTimeoutMin > 0
          ? `• ${state.replyTimeoutMin} 分返事が無いときは、スレッドに警告が出る`
          : undefined,
      ]
        .filter((l): l is string => l !== undefined)
        .join('\n')
    ),
  ];
}

/** 許可ユーザー以外に見せるホーム（中の情報は出さない） */
export function buildForbiddenHomeView(): unknown {
  return {
    type: 'home',
    blocks: [
      HEADER,
      section('このボットは、許可されたメンバーだけが使える。'),
    ],
  };
}
