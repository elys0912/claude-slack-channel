// Slack と Claude Code（MCP）をつなぐ配線。import 時の副作用は持たない（プロセス周りは main.ts）。
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { errMessage } from './errors.js';
import type { Logger } from './log.js';
import type { InstanceLock } from './lock.js';
import type { SlackBridge, ActionContext, InboundRef } from './slack.js';
import { ChannelServer } from './mcp.js';
import type { McpDeps } from './mcp.js';
import { PermissionRelay } from './permission-relay.js';
import { revealInvisible } from './permission.js';
import type { ActionParse } from './permission.js';
import type { GateResult } from './gate.js';
import type { PressedMessage, ThreadRef } from './types.js';
import { SessionControl } from './session-control.js';
import type { SessionControlOptions } from './session-control.js';
import { buildStatusText } from './status.js';
import { ResponseWatchdog, buildNoResponseText } from './watchdog.js';
import type { ConsoleAccess } from './console.js';
import { ScreenRelay, noticeBlocks } from './screen-relay.js';
import { RuleRelay } from './rule-relay.js';
import { buildRejectedRulesText, partitionStoredRules } from './allow-rules.js';
import { AllowRuleStore } from './allow-rule-store.js';
import { readAsk, readDeny } from './settings-files.js';
import { SessionAllowAll } from './session-allow.js';
import { buildForbiddenHomeView, buildHomeView } from './home.js';
import type { HomeCustom } from './home.js';
import { downloadAttachment } from './download.js';
import type { DownloadDeps } from './download.js';
import type { SlackFile } from './slack.js';
import { HookInbox } from './hook-inbox.js';
import type { HookEvent } from './hook-event.js';
import { hookToNotice } from './hook-notices.js';
import { NoticePoster } from './notice.js';
import { Keepalive, keepaliveStatusLine } from './keepalive.js';
import type { KeepaliveStatus, QuietHours } from './keepalive.js';
import { MS_PER_MINUTE, formatTime } from './text.js';
import { UsageWatch } from './usage-watch.js';
import { takeCrashNotice } from './crash-notice.js';

/** Slack のファイル ID で指す添付の取得 */
export type SlackDownloadDeps = DownloadDeps<string, SlackFile>;

// Slack 側で「読んだ」「許可した」「拒否した」を示すリアクション
export const REACTION = {
  SEEN: 'eyes',
  ALLOW: 'white_check_mark',
  DENY: 'x',
} as const;

// --- 依存の型（テストで差し替えられるよう、使うメソッドだけに絞る） -------------

/** MCP ツール（reply / react / edit_message）が使う Slack 側の操作 */
export type ToolBridge = Pick<SlackBridge, 'postText' | 'addReactionOrThrow' | 'updateText'>;

/** 受信処理・起動停止まで含めた Slack 側の操作 */
export type AppBridge = Pick<
  SlackBridge,
  'start' | 'stop' | 'postText' | 'postBlocks' | 'addReaction' | 'addReactionOrThrow' | 'updateText' | 'postToAll' | 'updateBlocks'
> &
  Partial<Pick<SlackBridge, 'publishHome' | 'isConnected'>>;

/** 受信処理が使う MCP サーバー側の操作 */
export type AppServer = Pick<ChannelServer, 'pushMessage'>;

/** 受信処理が使う permission relay の操作 */
export type AppRelay = Pick<PermissionRelay, 'answerByText' | 'answerByButton' | 'rememberThread' | 'lookup'>;

/** 無応答の見張りのうち、受信処理が使う操作 */
export type AppWatchdog = Pick<ResponseWatchdog, 'delivered'>;
export type AppScreen = Pick<ScreenRelay, 'show' | 'pick'>;
export type AppRules = Pick<RuleRelay, 'propose' | 'confirm' | 'list' | 'remove'>;
export type AppSession = Pick<SessionControl, 'restart' | 'compact' | 'clear'>;

export interface Wiring {
  bridge: AppBridge;
  server: AppServer;
  relay: AppRelay;
  logger: Logger;
  watchdog: AppWatchdog;
  /** ターミナル画面の確認・選択（コンソールが無ければ、読めない旨を返す） */
  screen: AppScreen;
  /** 許可リストへの追加（無ければ「今後も許可」は今回の許可だけになり、!rules は使えない） */
  rules?: AppRules | undefined;
  /** `!status` の文面 */
  status: () => string;
  /** `!restart` / `!compact` / `!clear`。無ければ使えない */
  session?: AppSession | undefined;
  /** 「このセッション中は全部許可」（.env で有効にしたボットだけ）。無ければボタンも !lock も使えない */
  sessionAllow?: SessionAllowAll | undefined;
  /** キャッシュのつなぎ止め。無ければ !keepalive は使えない */
  keepalive?: Pick<Keepalive, 'setEnabled' | 'status'> | undefined;
  /** メッセージを Claude に渡した後に呼ぶ（作業中の印・つなぎ止めの回数の数え直し） */
  onDelivered?: (() => void) | undefined;
}

/** Claude に渡さず、ブリッジ自身が処理するコマンド（`!restart force` だけ引数を取る） */
const COMMAND_RE = /^\s*!(help|screen|rules|status|restart(?:\s+force)?|compact|clear|lock|keepalive(?:\s+(?:on|off))?)\s*$/i;
/** COMMAND_RE が受け付けるコマンド（小文字・空白 1 つに正規化した形） */
const COMMANDS = [
  'help',
  'screen',
  'rules',
  'status',
  'restart',
  'restart force',
  'compact',
  'clear',
  'lock',
  'keepalive',
  'keepalive on',
  'keepalive off',
] as const;
export type Command = (typeof COMMANDS)[number];

function isCommand(name: string): name is Command {
  return (COMMANDS as readonly string[]).includes(name);
}

/** switch の網羅チェック。種類を足して case を書き忘れると、ここで型エラーになる */
export function assertNever(value: never): never {
  throw new Error(`想定外の値: ${JSON.stringify(value)}`);
}

/** キャッシュのつなぎ止めで Claude に送る本文（INSTRUCTIONS に、ツールを呼ばず ok とだけ書くよう書いてある） */
export const KEEPALIVE_TEXT = 'keepalive（キャッシュのつなぎ止め。ツールを呼ばずに ok とだけ書く）';

/** `!help` の文面。Slack では `/` で始まる文は Slack のコマンドとして扱われ Claude Code まで届かないので、その案内も添える */
export const HELP_TEXT = [
  '📖 ブリッジのコマンド（Claude には渡さず、ブリッジが処理する。Claude が止まっていても使える）',
  '• `!help` … この一覧',
  '• `!status` … ブリッジの稼働状態',
  '• `!screen` … ターミナルの画面を見る（選択画面ならボタンで選べる）',
  '• `!rules` … Slack から足した許可ルールの一覧と削除',
  '• `!compact` … /compact を送る（会話を要約して縮める）',
  '• `!clear` … /clear を送る（会話を捨てて新しい会話にする）',
  '• `!lock` … 「このセッション中は全部許可」を解除する（使えるボットだけ）',
  '• `!keepalive on` / `!keepalive off` … キャッシュのつなぎ止めを切り替える（`!keepalive` だけなら状態を見る）',
  '• `!restart` … /exit を送って起動し直す（会話は引き継ぐ）',
  '• `!restart force` … Claude Code を強制終了して起動し直す（応答しないとき用）',
  '',
  '`/` で始まる文は Slack のコマンドとして扱われ、Claude Code には届かない。スラッシュコマンドは上の `!` 版を使うこと。',
].join('\n');

/**
 * Slack のアプリ（Claude の Slack コネクタなど）が利用者の代わりに投稿したとき、本文の末尾に付く署名
 * （例: `*使用して送信されました* <@U0BF61P77U1>`）。太字 1 つとユーザーへのメンションだけの末尾に限る
 */
const APP_FOOTER_RE = /\s+\*[^*\n]+\*\s+<@U[A-Z0-9]+(?:\|[^>]*)?>\s*$/;

/** 本文がブリッジのコマンドならその名前（小文字・空白 1 つに正規化）を返す。アプリの署名が付いていても同じコマンドとみなす */
export function parseCommand(content: string): Command | undefined {
  const m = COMMAND_RE.exec(content) ?? COMMAND_RE.exec(content.replace(APP_FOOTER_RE, ''));
  const name = m?.[1]?.toLowerCase().replace(/\s+/g, ' ');
  return name !== undefined && isCommand(name) ? name : undefined;
}

// --- Claude → Slack（MCP ツールの実体） ----------------------------------------

export type ToolHandlers = Pick<McpDeps, 'onReply' | 'onReact' | 'onEdit' | 'onDownload'>;

/**
 * reply / react / edit_message / download_file の実体。失敗しても投げず、Claude が読めるエラー文を返す。
 * onActivity は返事にあたるツール（reply / react / edit_message）が呼ばれるたびに（成否によらず）呼ぶ。無応答の見張りを解くのに使う。
 * download_file は作業の途中で呼ぶものなので、見張りは解かない（保存だけして返事をせずに終えたら、無応答の警告を出す）。
 * download が無ければ download_file は出さない。
 */
export function createToolHandlers(
  bridge: ToolBridge,
  logger: Logger,
  onActivity?: () => void,
  download?: SlackDownloadDeps
): ToolHandlers {
  /** 作業の途中で呼ぶツール。無応答の見張りは解かない */
  const runWork = async (tool: string, action: () => Promise<string>): Promise<string> => {
    try {
      return await action();
    } catch (e) {
      logger.error(`${tool} に失敗`, e);
      return `error: ${errMessage(e)}`;
    }
  };
  /** 返事にあたるツール。成否によらず、先に onActivity を呼ぶ */
  const runAnswer = async (tool: string, action: () => Promise<string>): Promise<string> => {
    onActivity?.();
    return runWork(tool, action);
  };

  return {
    onReply: ({ chat_id, text, thread_ts }) =>
      runAnswer('reply', async () => {
        const res = await bridge.postText(chat_id, text, thread_ts);
        // 送ったメッセージの ts。自分の返信を edit_message で直すときに使う
        return `sent (${res.ts.length} message(s)) ts=${res.ts.join(',')}`;
      }),

    onReact: ({ chat_id, message_id, emoji }) =>
      runAnswer('react', async () => {
        // Claude が `:eyes:` のようにコロン付きで渡してきても受け付ける
        await bridge.addReactionOrThrow(chat_id, message_id, emoji.replace(/^:|:$/g, ''));
        return 'reacted';
      }),

    onEdit: ({ chat_id, message_id, text }) =>
      runAnswer('edit_message', async () => {
        await bridge.updateText(chat_id, message_id, text);
        return 'edited';
      }),

    onDownload: download
      ? ({ file_id, extract }) =>
          runWork('download_file', async () => {
            const result = await downloadAttachment(download, file_id, extract ?? false);
            logger.info(`download_file file=${file_id} extract=${extract ?? false}`);
            return result;
          })
      : undefined,
  };
}

/** 縮退モード: ツールはすべてエラーを返し、permission_request は無視する */
export function createDegradedDeps(logger: Logger): McpDeps {
  const busy = (): Promise<string> =>
    Promise.resolve('error: 別のインスタンスが動いているため、この Slack ブリッジは送信できない');

  return {
    logger,
    onReply: busy,
    onReact: busy,
    onEdit: busy,
    onPermissionRequest: () => {
      logger.warn('縮退モードのため permission_request を無視する');
    },
  };
}

// --- Slack → Claude（受信イベントの処理） --------------------------------------

/** DM か許可チャンネルで届いたメッセージ。保留中の ID への `yes xxxxx` / `no xxxxx` なら許可の回答、それ以外は Claude へ中継する */
export async function handleMessage(wiring: Wiring, result: GateResult, raw: InboundRef): Promise<void> {
  const { bridge, server, relay, logger, watchdog, onDelivered } = wiring;
  /** 届いたメッセージのスレッド（返事の投稿先） */
  const thread: ThreadRef | undefined = raw.channel && raw.threadTs ? { channel: raw.channel, threadTs: raw.threadTs } : undefined;
  /** 届いたメッセージそのもの（リアクションを付ける先） */
  const message = raw.channel && raw.ts ? { channel: raw.channel, ts: raw.ts } : undefined;

  // `!screen` などのコマンドは Claude に渡さずにここで処理する（Claude が止まっていても使えるように）
  const command = result.kind === 'deliver' ? parseCommand(result.content) : undefined;
  if (command && thread) {
    if (message) await bridge.addReaction(message.channel, message.ts, REACTION.SEEN);
    await handleCommand(wiring, command, thread, raw.user ?? '');
    return;
  }

  switch (result.kind) {
    case 'drop':
      logger.debug(`受信を破棄 reason=${result.reason}`);
      return;

    case 'verdict':
      // gate 通過後に期限が切れた場合は Claude に送っていないので、リアクションも付けない
      if (!(await relay.answerByText(result.verdict, raw.user ?? ''))) return;
      if (message) {
        const reaction = result.verdict.behavior === 'allow' ? REACTION.ALLOW : REACTION.DENY;
        await bridge.addReaction(message.channel, message.ts, reaction);
      }
      return;

    case 'deliver':
      if (thread) relay.rememberThread(thread.channel, thread.threadTs);
      await server.pushMessage(result.content, result.meta);
      if (thread) watchdog.delivered(thread);
      onDelivered?.();
      if (message) await bridge.addReaction(message.channel, message.ts, REACTION.SEEN);
      return;

    default:
      assertNever(result);
  }
}

/** ブリッジ自身のコマンド。使えない環境ではその旨をスレッドに返す */
async function handleCommand(
  { bridge, screen, rules, status, session, sessionAllow, keepalive, logger }: Wiring,
  command: Command,
  at: ThreadRef,
  byUserId: string
): Promise<void> {
  const unavailable = (name: string): Promise<unknown> => bridge.postText(at.channel, `⚠️ このブリッジでは ${name} を使えない`, at.threadTs);
  switch (command) {
    case 'help':
      await bridge.postText(at.channel, HELP_TEXT, at.threadTs);
      return;
    case 'screen':
      await screen.show(at.channel, at.threadTs);
      return;
    case 'rules':
      if (rules) await rules.list(at.channel, at.threadTs);
      else await unavailable('!rules');
      return;
    case 'status':
      await bridge.postText(at.channel, status(), at.threadTs);
      return;
    case 'restart':
    case 'restart force':
      if (session) await session.restart(at, byUserId, command === 'restart force');
      else await unavailable('!restart');
      return;
    case 'compact':
      if (session) await session.compact(at, byUserId);
      else await unavailable('!compact');
      return;
    case 'clear':
      if (session) await session.clear(at, byUserId);
      else await unavailable('!clear');
      return;
    case 'lock':
      if (!sessionAllow) {
        await unavailable('!lock');
        return;
      }
      if (sessionAllow.disable()) {
        logger.info(`全部許可を解除 by=${byUserId}（!lock）`);
        await bridge.postText(at.channel, '🔒 「このセッション中は全部許可」を解除した。次からはまたボタンで確認する', at.threadTs);
      } else {
        await bridge.postText(at.channel, '「このセッション中は全部許可」は有効になっていない', at.threadTs);
      }
      return;
    case 'keepalive':
    case 'keepalive on':
    case 'keepalive off': {
      if (!keepalive) {
        await unavailable('!keepalive');
        return;
      }
      if (command !== 'keepalive') {
        keepalive.setEnabled(command === 'keepalive on');
        logger.info(`keepalive を ${command === 'keepalive on' ? '有効' : '無効'}にした by=${byUserId}`);
      }
      await bridge.postText(at.channel, keepaliveStatusText(keepalive.status()), at.threadTs);
      return;
    }
    default:
      assertNever(command);
  }
}

/** `!keepalive` に返す状態の文 */
function keepaliveStatusText(status: KeepaliveStatus): string {
  if (!status.enabled) return '♻️ キャッシュのつなぎ止め: 無効（起動し直すと .env の設定に戻る）';

  const next = status.nextAt ? `次は ${formatTime(status.nextAt)}` : '予定なし（Claude が次に応答を終えたら決まる）';
  return `♻️ キャッシュのつなぎ止め: 有効（${next}、送った回数 ${status.sent}/${status.max}）`;
}

/** permission request のボタン（Allow / Deny / See more）が押されたとき */
export async function handleAction(wiring: Wiring, parsed: ActionParse, ctx: ActionContext): Promise<void> {
  if (!parsed.ok) {
    wiring.logger.warn(`block_actions を無視 reason=${parsed.reason}`);
    return;
  }

  const pressed = ctx.channelId && ctx.messageTs ? { channel: ctx.channelId, ts: ctx.messageTs } : undefined;
  const at = pressedMessage(ctx);
  const byUserId = ctx.userId ?? '';

  switch (parsed.kind) {
    case 'verdict':
      await wiring.relay.answerByButton(parsed.verdict, byUserId, pressed);
      return;

    case 'see_more':
      await sendFullPreview(wiring, parsed.requestId, ctx);
      return;

    case 'allow_always': {
      // 回答すると保留から消えるので、先に中身を控えておく
      const req = wiring.relay.lookup(parsed.requestId);
      await wiring.relay.answerByButton({ requestId: parsed.requestId, behavior: 'allow' }, byUserId, pressed);
      if (req && at && wiring.rules) await wiring.rules.propose(req, at.channel, at.threadTs);
      return;
    }

    case 'allow_session':
      // 期限切れのボタンでは有効にしない（answerByButton が期限切れ表示に書き換える）
      if (wiring.sessionAllow && wiring.relay.lookup(parsed.requestId)) {
        wiring.sessionAllow.enable(byUserId);
        wiring.logger.info(`全部許可を開始 by=${byUserId}`);
        if (at) {
          await wiring.bridge.postText(
            at.channel,
            '🔓 このセッション中は、settings の ask に当たるもの以外を自動で許可する（deny は今までどおり実行されない）。自動で許可した操作はスレッドに残す。!lock で解除、!clear か起動し直しでも解除される',
            at.threadTs
          );
        }
      }
      await wiring.relay.answerByButton({ requestId: parsed.requestId, behavior: 'allow' }, byUserId, pressed);
      return;

    case 'screen_show':
      if (at) await wiring.screen.show(at.channel, at.threadTs);
      return;

    case 'screen_pick':
      if (at) await wiring.screen.pick(parsed.snapshotId, parsed.index, at, byUserId);
      return;

    case 'rule_confirm':
      if (at && wiring.rules) await wiring.rules.confirm(parsed.proposalId, parsed.accept, at, byUserId);
      return;

    case 'rule_remove':
      if (at && wiring.rules) await wiring.rules.remove(parsed.rule, at, byUserId);
      return;

    default:
      assertNever(parsed);
  }
}

/**
 * ボタンが押されたメッセージの位置。結果の書き換え先（ts）と、投稿先のスレッド
 * （ボタンのメッセージが属するスレッド。スレッド外ならボタンのメッセージ自身を起点にする）。チャンネルが分からなければ undefined
 */
function pressedMessage(ctx: ActionContext): PressedMessage | undefined {
  const threadTs = ctx.threadTs ?? ctx.messageTs;
  if (!ctx.channelId || !threadTs) return undefined;
  return { channel: ctx.channelId, ts: ctx.messageTs, threadTs };
}

/**
 * input_preview をコードブロックで包む。中身の行頭の ``` はゼロ幅スペースを前置して、
 * フェンスの開閉と誤認されない（分割送信時の開き直しも崩れない）ようにする。
 */
export function fencePreview(preview: string): string {
  return '```\n' + preview.replace(/^```/gm, '\u200b```') + '\n```';
}

/**
 * See more: ボタンのメッセージでは省略した input_preview の全文をスレッドに送る。
 * 不可視文字（双方向制御・ゼロ幅・BOM）は revealInvisible で `\u{XXXX}` に置き換えてから送る。
 * 長いときは postText がコードブロックを保ったまま複数メッセージに分ける。期限切れならその旨だけ送る。
 * 送り先はボタンのメッセージが属するスレッド（スレッド外ならボタンのメッセージ自身を起点にする）。
 */
async function sendFullPreview({ bridge, relay, logger }: Wiring, requestId: string, ctx: ActionContext): Promise<void> {
  const at = pressedMessage(ctx);
  if (!at) return;

  const req = relay.lookup(requestId);
  try {
    if (req) {
      await bridge.postText(at.channel, fencePreview(revealInvisible(req.input_preview)), at.threadTs);
    } else {
      await bridge.postText(at.channel, `⌛ permission request ${requestId} は既に期限切れ`, at.threadTs);
    }
  } catch (e) {
    logger.warn('see_more の送信に失敗', e);
  }
}

// --- 起動 ---------------------------------------------------------------------

export interface RunningApp {
  /** 後片付け（lock.release → hook の読み取りと無応答の見張りを止める → 保留中の permission request を deny → ホームを停止中にする（通常モードのみ） → bridge.stop → server.close の順。2 回目以降の呼び出しは 1 回目と同じ Promise を返す） */
  stop: () => Promise<void>;
}

export interface BridgeAppOptions {
  /** init() 済みの SlackBridge */
  bridge: AppBridge;
  logger: Logger;
  /** MCP のトランスポート。省略時は stdio */
  transport?: Transport | undefined;
  /**
   * 接続済みの MCP サーバー（縮退モードから戻るとき）。渡したら新しく作らず、ツールの実体を差し替えて使う（transport は使わない）。
   * 起動に失敗したときは閉じない（縮退モードに戻して使い続けるため）
   */
  server?: ChannelServer | undefined;
  /** stop() の最初に release する（後片付けが固まってもロックを残さないため） */
  lock?: Pick<InstanceLock, 'release'> | undefined;
  /**
   * bridge.start() より前に、後片付けの関数を渡して呼ぶ。終了処理（stdin の終了・シグナル）の登録に使い、
   * Socket Mode の接続待ちの最中に Claude Code が終了しても後片付けされるようにする。
   */
  onCleanupReady?: ((stop: () => Promise<void>) => void) | undefined;
  /**
   * Claude に渡したメッセージへの応答（reply / react / edit_message / permission_request）を待つ時間（ミリ秒）。
   * 過ぎたらそのスレッドに無応答の警告を投稿する。0 以下なら見張らない。省略時は見張らない
   */
  replyTimeoutMs?: number | undefined;
  /** ターミナル画面の読み取り・選択キーの送信。省略時は !screen と画面のボタンが使えない */
  console?: ConsoleAccess | undefined;
  /** Slack から追加した許可ルールの保存先（状態ディレクトリの allow-extra.json）。省略時は「今後も許可」で追加しない */
  allowExtraFile?: string | undefined;
  /** 追加の前に照合する deny を読む設定ファイル（channel-settings.json と作業フォルダーの .claude/settings*.json） */
  denyFiles?: string[] | undefined;
  /** 作業フォルダー（!status とホームタブに出す）。省略時は「(不明)」 */
  workDir?: string | undefined;
  /**
   * アプリのホームタブに状態を出す。起動時に users 全員のホームを「稼働中」にし、終了時に「停止中」へ書き換え、
   * ホームが開かれたら最新の状態で出し直す。省略時はホームを更新しない
   */
  home?:
    | {
        users: string[];
        channelCount: number;
        botUserId?: string | undefined;
        /** ホームの文面の差し替え（home.json）を読む。ホームを出すたびに呼ぶので、書き換えは次に開いたときから反映される */
        loadCustom?: (() => HomeCustom | undefined) | undefined;
      }
    | undefined;
  /** 添付の保存先と取得手段（.env の DOWNLOAD_DIR があるとき）。省略時は download_file を出さない */
  download?: SlackDownloadDeps | undefined;
  /**
   * Claude Code の hook が追記する記録（状態ディレクトリの hooks.jsonl）。読んで、ターミナル側の入力待ち・
   * 使用量の上限・セッションの開始と終了・圧縮を Slack に知らせる。省略時は読まない
   */
  hookInboxFile?: string | undefined;
  /** hooks.jsonl を読みに行く間隔（ミリ秒。テスト用。省略時は hook-inbox.ts の既定） */
  hookPollMs?: number | undefined;
  /** hook の記録のうち扱う行の session_tag（start.ps1 が環境変数 SLACK_CHANNEL_SESSION_TAG で渡す）。省略時は全部扱う */
  sessionTag?: string | undefined;
  /** `!restart` が置く印（状態ディレクトリの restart.flag。start.ps1 が見て起動し直す）。省略時は !restart・!compact・!clear を使えない */
  restartFlagFile?: string | undefined;
  /** `!restart force` で claude.exe を止める手段（テスト用。省略時は taskkill でプロセスツリーごと止める） */
  killParent?: SessionControlOptions['killParent'];
  /** 実行許可に「このセッション中は全部許可」ボタンを出すか（.env の SESSION_ALLOW_ALL）。除外する ask は denyFiles と managedSettingsFiles から読む */
  sessionAllowAll?: boolean | undefined;
  /** managed settings（組織の管理設定）のファイルの一覧を返す。全部許可で除外する ask に加える。省略時は読まない（テスト用） */
  managedSettingsFiles?: (() => string[]) | undefined;
  /** キャッシュのつなぎ止めの設定。省略時はつなぎ止めない（hook の記録が無いと応答の終わりが分からないので、hookInboxFile も要る） */
  keepalive?: { enabled: boolean; afterMs: number; max: number; quiet: QuietHours | undefined } | undefined;
  /** 使用量とコンテキストの見張り（statusline が書く usage.json としきい値）。省略時は見張らない */
  usageWatch?: { file: string; usageWarnPct: number[]; contextWarnPct: number[]; pollMs?: number | undefined } | undefined;
  /** start.ps1 が想定外の終了から起動し直したときに置く印（状態ディレクトリの crash.json）。起動後に読んで知らせ、消す */
  crashFile?: string | undefined;
}

/**
 * ホームタブの更新。opts.home が無いか、bridge がホームを出せなければ何もしない。
 * publishHomeAll: users 全員のホームを書き換える。onHomeOpened: ホームが開かれたら最新の状態で出し直す
 */
function wireHome(
  opts: BridgeAppOptions,
  ruleStore: AllowRuleStore | undefined,
  startedAt: Date
): {
  publishHomeAll: (running: boolean, since: Date) => Promise<void>;
  onHomeOpened: (user: string, allowed: boolean) => Promise<void>;
} {
  const { bridge, home } = opts;
  const view = (running: boolean, since: Date): unknown =>
    buildHomeView({
      running,
      since,
      workDir: opts.workDir ?? '',
      channelCount: home?.channelCount ?? 0,
      botUserId: home?.botUserId,
      custom: home?.loadCustom?.(),
      ruleCount: ruleStore?.list().length,
      replyTimeoutMin: Math.round((opts.replyTimeoutMs ?? 0) / MS_PER_MINUTE),
      now: new Date(),
    });
  return {
    publishHomeAll: async (running, since) => {
      if (!home || !bridge.publishHome) return;
      for (const user of home.users) await bridge.publishHome(user, view(running, since));
    },
    onHomeOpened: async (user, allowed) => {
      if (!home || !bridge.publishHome) return;
      await bridge.publishHome(user, allowed ? view(true, startedAt) : buildForbiddenHomeView());
    },
  };
}

/** hook の記録と中継から分かる、Claude の会話の状態。つなぎ止めと !restart が読む */
interface TurnState {
  /** Claude がターンの途中（中継してから、または手元で入力してから Stop まで） */
  turnActive: boolean;
  /** 使用量の上限に当たっている（StopFailure の rate_limit から、次に応答が終わるまで） */
  limited: boolean;
  /** 今の会話の session_id（自分のセッションの hook の記録で最後に見たもの）。!restart で同じ会話を開き直すのに使う */
  sessionId: string | undefined;
}

/** applyHookEvent が状態を知らせる先と、知らせの投稿に使うもの */
interface HookEventDeps {
  keepalive: Keepalive | undefined;
  usageWatch: UsageWatch | undefined;
  sessionAllow: SessionAllowAll | undefined;
  notice: NoticePoster;
  watchdog: ResponseWatchdog;
  relay: PermissionRelay;
  logger: Logger;
  /** 知らせに「画面を見る」ボタンを付けられるか（コンソールを読めるか） */
  hasConsole: boolean;
}

/** hook の記録 1 行を、会話の状態とつなぎ止め・見張りに反映し、必要なら Slack に知らせる */
async function applyHookEvent(event: HookEvent, state: TurnState, deps: HookEventDeps): Promise<void> {
  const { keepalive, usageWatch, sessionAllow, notice, watchdog, relay, logger } = deps;
  if (event.session_id) state.sessionId = event.session_id;
  switch (event.hook_event_name) {
    case 'UserPromptSubmit':
      state.turnActive = true;
      break;
    case 'Stop':
      state.turnActive = false;
      state.limited = false;
      usageWatch?.limitCleared();
      keepalive?.requestEnded(event.at);
      break;
    case 'StopFailure':
      state.turnActive = false;
      if (event.error === 'rate_limit') {
        state.limited = true;
        usageWatch?.limitHit();
      }
      keepalive?.requestEnded(event.at);
      break;
    case 'SessionStart':
      keepalive?.resetCount();
      usageWatch?.contextReset();
      break;
    case 'PostCompact':
      usageWatch?.contextReset();
      break;
  }

  // !clear などで新しい会話になったら、「全部許可」を解除する（会話ごとに許可し直す）
  if (event.hook_event_name === 'SessionStart' && event.source === 'clear' && sessionAllow?.disable()) {
    logger.info('全部許可を解除（新しい会話）');
    await notice.post('🔒 新しい会話になったので「このセッション中は全部許可」を解除した');
  }

  const found = hookToNotice(event, { waiting: watchdog.isWaiting(), pending: relay.pendingCount() });
  if (!found) return;
  logger.info(`hook を知らせる event=${event.hook_event_name} type=${event.notification_type ?? '-'}`);
  await notice.post(found.text, noticeBlocks(found.text, found.screenButton && deps.hasConsole));
}

/** `!status` の文面を作るのに読むもの */
interface StatusSources {
  startedAt: Date;
  workDir: string | undefined;
  bridge: AppBridge;
  watchdog: ResponseWatchdog;
  relay: PermissionRelay;
  inbox: HookInbox | undefined;
  sessionAllow: SessionAllowAll | undefined;
  keepalive: Keepalive | undefined;
  usageWatch: UsageWatch | undefined;
}

/** `!status` の文面。呼ぶたびにその時点の状態から作る */
function buildBridgeStatus(src: StatusSources): string {
  const { watchdog, keepalive, usageWatch, sessionAllow } = src;
  const waiting = watchdog.waitingSince();
  return buildStatusText({
    startedAt: src.startedAt,
    workDir: src.workDir ?? '',
    slackConnected: src.bridge.isConnected,
    waitingSince: waiting === undefined ? undefined : new Date(waiting),
    pendingPermissions: src.relay.pendingCount(),
    lastHooks: src.inbox?.lastEvents(5) ?? [],
    sessionAllowSince: sessionAllow ? (sessionAllow.current?.since ?? null) : undefined,
    extraLines: [keepalive ? keepaliveStatusLine(keepalive.status()) : undefined, usageWatch?.statusLine()].filter(
      (line): line is string => line !== undefined
    ),
    now: new Date(),
  });
}

/**
 * 通常モード: Slack と Claude Code（MCP）をつないで中継を始める。
 * MCP の接続か Socket Mode の開始に失敗したら、後片付け（RunningApp.stop と同じ手順）をしてから投げ直す。
 */
export async function startBridgeApp(opts: BridgeAppOptions): Promise<RunningApp> {
  const { bridge, logger } = opts;

  const watchdog = new ResponseWatchdog({
    timeoutMs: opts.replyTimeoutMs ?? 0,
    logger,
    notify: async ({ channel, threadTs }, minutes) => {
      const text = buildNoResponseText(minutes);
      await bridge.postBlocks(channel, text, noticeBlocks(text, opts.console !== undefined), threadTs);
    },
  });
  const screen = new ScreenRelay({ console: opts.console, slack: bridge, logger });
  const ruleStore = opts.allowExtraFile ? new AllowRuleStore(opts.allowExtraFile) : undefined;
  const rules = ruleStore
    ? new RuleRelay({
        store: ruleStore,
        loadDeny: () => (opts.denyFiles ?? []).flatMap((f) => readDeny(f)),
        slack: bridge,
        logger,
      })
    : undefined;

  // server と relay は互いを参照する。relay を使うのは接続後なので、宣言順はこれでよい
  const deps: McpDeps = {
    logger,
    ...createToolHandlers(bridge, logger, () => watchdog.activity(), opts.download),
    onPermissionRequest: (req) => {
      watchdog.activity();
      return relay.request(req);
    },
  };
  const server: ChannelServer = opts.server ?? new ChannelServer(deps);
  // deny に当たる操作は Claude Code が確認を出す前に止めるので、照合するのは ask だけ。
  // managed の ask も、--settings より優先して Claude Code が確認を求めるので照合する
  const loadAskRules = (): string[] =>
    [...(opts.denyFiles ?? []), ...(opts.managedSettingsFiles?.() ?? [])].flatMap((f) => readAsk(f));
  const sessionAllow = opts.sessionAllowAll ? new SessionAllowAll(loadAskRules) : undefined;
  const relay: PermissionRelay = new PermissionRelay(bridge, server, logger, undefined, sessionAllow);
  const startedAt = new Date();
  const turn: TurnState = { turnActive: false, limited: false, sessionId: undefined };

  // --- hook の記録 → Slack への知らせ・使用量の見張り -------------------------------
  const notice = new NoticePoster(bridge, () => relay.lastThread, logger);
  const usageWatch = opts.usageWatch
    ? new UsageWatch({
        ...opts.usageWatch,
        sessionTag: opts.sessionTag,
        notify: (text) => notice.post(text),
        logger,
      })
    : undefined;

  // --- キャッシュのつなぎ止め ------------------------------------------------------
  const keepalive =
    opts.keepalive && opts.hookInboxFile
      ? new Keepalive({
          ...opts.keepalive,
          send: () => server.pushMessage(KEEPALIVE_TEXT, { kind: 'keepalive' }),
          isBusy: () => turn.turnActive || watchdog.isWaiting() || relay.pendingCount() > 0,
          // 使用量がしきい値を越えている間も送らない（合図でも使用量を使うため）
          isLimited: () => turn.limited || (usageWatch?.isHigh() ?? false),
          logger,
        })
      : undefined;

  const hookDeps: HookEventDeps = {
    keepalive,
    usageWatch,
    sessionAllow,
    notice,
    watchdog,
    relay,
    logger,
    hasConsole: opts.console !== undefined,
  };
  const inbox = opts.hookInboxFile
    ? new HookInbox({
        file: opts.hookInboxFile,
        logger,
        pollMs: opts.hookPollMs,
        sessionTag: opts.sessionTag,
        onEvent: (event) => applyHookEvent(event, turn, hookDeps),
      })
    : undefined;

  // --- !status / !restart / !compact / !clear -------------------------------------
  const statusSources: StatusSources = {
    startedAt,
    workDir: opts.workDir,
    bridge,
    watchdog,
    relay,
    inbox,
    sessionAllow,
    keepalive,
    usageWatch,
  };
  const session = opts.restartFlagFile
    ? new SessionControl({ console: opts.console, restartFlagFile: opts.restartFlagFile, bridge, logger, killParent: opts.killParent, sessionId: () => turn.sessionId })
    : undefined;
  const wiring: Wiring = {
    bridge,
    server,
    relay,
    logger,
    watchdog,
    screen,
    rules,
    status: () => buildBridgeStatus(statusSources),
    session,
    sessionAllow,
    keepalive,
    onDelivered: () => {
      turn.turnActive = true;
      keepalive?.resetCount();
    },
  };

  // --- ホームタブ -------------------------------------------------------------
  const { publishHomeAll, onHomeOpened } = wireHome(opts, ruleStore, startedAt);

  let stopped: Promise<void> | undefined;
  /** 起動に失敗したか（受け取った server は、そのときは閉じない） */
  let startFailed = false;
  const stop = (): Promise<void> =>
    (stopped ??= (async () => {
      opts.lock?.release();
      inbox?.stop();
      session?.stop();
      keepalive?.stop();
      usageWatch?.stop();
      watchdog.stop();
      try {
        // Slack の書き換えと Claude への通知が届くよう、切断より前に行う（denyAll・publishHome は投げない）
        await relay.denyAll('ブリッジ終了');
        await publishHomeAll(false, new Date());
        await bridge.stop();
      } finally {
        if (!(startFailed && opts.server)) await server.close();
      }
    })());
  opts.onCleanupReady?.(stop);

  try {
    if (opts.server) await server.replaceDeps(deps);
    else if (opts.transport) await server.connect(opts.transport);
    else await server.connectStdio();
    await bridge.start({
      onMessage: (result, raw) => handleMessage(wiring, result, raw),
      onAction: (parsed, ctx) => handleAction(wiring, parsed, ctx),
      isKnownRequest: (id) => relay.lookup(id) !== undefined,
      onHomeOpened,
    });
  } catch (e) {
    startFailed = true;
    await stop().catch((err: unknown) => logger.error('起動失敗後の後片付けで例外', err));
    throw e;
  }
  logger.info('Slack ブリッジ稼働中');

  // 起動の途中で終了処理（stdin の終了など）が始まっていたら、それ以上は始めない（止めた後に投稿やタイマーを残さない）。
  // 終了処理は await の間に始まり得るので、手順ごとに確かめ直す
  const afterStart: (() => Promise<void> | void)[] = [
    () => publishHomeAll(true, startedAt),
    () => (ruleStore ? noticeRejectedRules(ruleStore, notice, logger) : undefined),
    () => inbox?.start(),
    () => (opts.crashFile ? noticeCrash(opts.crashFile, notice, logger) : undefined),
    () => usageWatch?.start(),
  ];
  for (const step of afterStart) {
    if (stopped !== undefined) break;
    await step();
  }

  return { stop };
}

/**
 * allow-extra.json のうち、今の方式では作れないルール（前の方式で足したもの）を知らせる。
 * start.ps1 はこれらを allow に入れていない（dist/src/allow-extra-check.js と同じ判定）
 */
async function noticeRejectedRules(store: AllowRuleStore, notice: NoticePoster, logger: Logger): Promise<void> {
  const { rejected } = partitionStoredRules(store.list());
  const text = buildRejectedRulesText(rejected);
  if (text === undefined) return;
  logger.warn(`今の方式では作れない保存済みのルール ${rejected.length} 件を allow に入れていない: ${rejected.join(', ')}`);
  writeStderr(text);
  await notice.post(text);
}

/** start.ps1 が想定外の終了から起動し直したときの印（crash.json）があれば、読んで知らせる（印は takeCrashNotice が消す） */
async function noticeCrash(file: string, notice: NoticePoster, logger: Logger): Promise<void> {
  const crashed = takeCrashNotice(file);
  if (!crashed) return;
  logger.warn('想定外の終了から起動し直した');
  await notice.post(crashed);
}

/** stderr（Claude Code の /mcp で見える）に 1 行書く。接頭辞と改行はここで付ける */
export function writeStderr(message: string): void {
  process.stderr.write(`[slackbridge] ${message}\n`);
}

/** 縮退中にロックを取り直す間隔（lock.ts のロックの失効 staleMs の既定と同じ） */
export const DEGRADED_RELOCK_MS = 30000;

export interface DegradedAppOptions {
  logger: Logger;
  /** MCP のトランスポート。省略時は stdio */
  transport?: Transport | undefined;
  /** 縮退中にロックを取り直し、取れたら通常のブリッジに戻る。省略時は取り直さない */
  relock?:
    | {
        lock: Pick<InstanceLock, 'tryAcquire' | 'release'>;
        /** 取り直す間隔（ミリ秒。テスト用。省略時は DEGRADED_RELOCK_MS） */
        intervalMs?: number | undefined;
        /**
         * ロックが取れたら、接続済みの server を渡して呼ぶ。通常のブリッジを始めて返す（startBridgeApp に server を渡す）。
         * 投げたらロックを手放して縮退モードに戻り、次の間隔でまた取り直す
         */
        promote: (server: ChannelServer) => Promise<RunningApp>;
      }
    | undefined;
}

/**
 * 縮退モード: MCP サーバーだけ起動し、ツールはすべてエラーを返す。
 * relock があれば、ロックが取れるまで取り直し、取れたら同じ MCP サーバーのまま通常のブリッジに戻る
 * （戻ったことは Slack には投稿せず、ログにだけ書く）
 */
export async function startDegradedApp(opts: DegradedAppOptions): Promise<RunningApp> {
  const { logger, relock } = opts;
  const server = new ChannelServer(createDegradedDeps(logger));
  if (opts.transport) await server.connect(opts.transport);
  else await server.connectStdio();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let promoting: Promise<void> | undefined;
  let promoted: RunningApp | undefined;
  let stopped: Promise<void> | undefined;

  const tryPromote = async (): Promise<void> => {
    if (!relock || stopped) return;
    if (!relock.lock.tryAcquire().acquired) {
      schedule();
      return;
    }
    logger.info('ロックが取れたので、縮退モードから通常のブリッジに戻る');
    try {
      promoted = await relock.promote(server);
      logger.info('通常のブリッジに戻った');
    } catch (e) {
      logger.warn('通常のブリッジに戻れなかったので、縮退モードを続ける', e);
      relock.lock.release();
      await server.replaceDeps(createDegradedDeps(logger));
      schedule();
    }
  };
  function schedule(): void {
    if (!relock || stopped) return;
    timer = setTimeout(() => {
      promoting = tryPromote().catch((e: unknown) => logger.error('ロックの取り直しで例外', e));
    }, relock.intervalMs ?? DEGRADED_RELOCK_MS);
    timer.unref();
  }
  schedule();

  const stop = (): Promise<void> =>
    (stopped ??= (async () => {
      clearTimeout(timer);
      // 戻る途中なら、終わるのを待ってから止める（始めかけたブリッジを残さない）
      await promoting;
      if (promoted) await promoted.stop();
      else await server.close();
    })());
  return { stop };
}
