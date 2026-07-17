// ターミナル画面の確認と、Slack からの選択画面の解除。
// 画面を読んで選択画面なら選択肢をボタンで出し、押されたら画面を読み直して同じ画面のときだけ選択キーを送る。
// 自由な文字入力は送らない（Slack から任意のコマンドを打ち込めないようにするため）。
import type { ConsoleAccess } from './console.js';
import type { Logger } from './log.js';
import { redact } from './log.js';
import { errMessage } from './errors.js';
import { choiceFingerprint, keysToSelect, parseChoiceScreen, screenTail } from './screen.js';
import type { ChoiceScreen } from './screen.js';
import { clip, newToken } from './text.js';
import type { PressedMessage } from './types.js';
import { ACTION, PLAIN_TEXT_LIMIT, numberedAction } from './permission.js';
import type { SlackBridge } from './slack.js';
import { BUTTON_LABEL_MAX, plainSection } from './blocks.js';

/** 選択肢のボタンの有効期限 */
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
/** 通知欄（text）に出す見出しの長さ */
const NOTIFICATION_TITLE_MAX = 100;

export type ScreenSlack = Pick<SlackBridge, 'postText' | 'postBlocks' | 'updateBlocks'>;

interface Snapshot {
  fingerprint: string;
  choice: ChoiceScreen;
  expiresAt: number;
}

export interface ScreenRelayOptions {
  /** 画面を読めない環境（コンソールが無い・スクリプトが無い）なら undefined */
  console: ConsoleAccess | undefined;
  slack: ScreenSlack;
  logger: Logger;
  now?: () => number;
  newId?: () => string;
}

/** 無応答の警告などに付ける「画面を確認」ボタン */
export function screenShowButton(): unknown {
  return {
    type: 'button',
    text: { type: 'plain_text', text: '🖥 画面を確認' },
    action_id: ACTION.SCREEN_SHOW,
    value: 'show',
  };
}

/** 知らせの blocks。withScreenButton なら「🖥 画面を確認」ボタンを添える */
export function noticeBlocks(text: string, withScreenButton: boolean): unknown[] {
  return [plainSection(text), ...(withScreenButton ? [{ type: 'actions', elements: [screenShowButton()] }] : [])];
}

export class ScreenRelay {
  private readonly console: ConsoleAccess | undefined;
  private readonly slack: ScreenSlack;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(opts: ScreenRelayOptions) {
    this.console = opts.console;
    this.slack = opts.slack;
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? newToken;
  }

  /** 画面を読んでスレッドに出す。選択画面なら選択肢のボタン、そうでなければ画面の末尾。投げない */
  async show(channel: string, threadTs: string): Promise<void> {
    try {
      if (!this.console) {
        await this.slack.postText(channel, '⚠️ このブリッジからはターミナルの画面を読めない（コンソールが無い）。', threadTs);
        return;
      }
      const screen = await this.console.read();
      const choice = parseChoiceScreen(screen);
      if (!choice) {
        const tail = redact(screenTail(screen));
        await this.slack.postText(
          channel,
          `🖥 選択画面は見つからなかった。画面の末尾:\n\`\`\`\n${tail || '(空)'}\n\`\`\``,
          threadTs
        );
        return;
      }
      this.prune();
      const id = this.newId();
      this.snapshots.set(id, { fingerprint: choiceFingerprint(choice), choice, expiresAt: this.now() + SNAPSHOT_TTL_MS });
      const { text, blocks } = buildChoiceBlocks(id, choice);
      await this.slack.postBlocks(channel, text, blocks, threadTs);
      this.logger.info(`選択画面を Slack に表示 id=${id} 選択肢=${choice.options.length}`);
    } catch (e) {
      this.logger.warn('画面の確認に失敗', e);
      await this.slack.postText(channel, `⚠️ 画面を読めなかった: ${errMessage(e)}`, threadTs).catch(() => undefined);
    }
  }

  /**
   * 選択肢のボタンが押された。画面を読み直して、見せたときと同じ選択画面なら選択キーを送り、
   * 押されたメッセージを結果の表示に書き換える。期限切れ・画面が変わっていたら何も送らず知らせる。投げない。
   */
  async pick(snapshotId: string, index: number, pressed: PressedMessage, byUserId: string): Promise<void> {
    const report = (message: string): Promise<void> => this.report(pressed, message);

    const snapshot = this.snapshots.get(snapshotId);
    this.snapshots.delete(snapshotId);
    if (!snapshot || this.now() > snapshot.expiresAt) {
      await report('⌛ この選択肢は期限切れ。もう一度「画面を確認」から選び直すこと。');
      return;
    }
    const option = snapshot.choice.options[index];
    if (!option || !this.console) {
      await report('⚠️ 選べない選択肢だった。');
      return;
    }

    try {
      const current = parseChoiceScreen(await this.console.read());
      if (!current || choiceFingerprint(current) !== snapshot.fingerprint) {
        await report('⚠️ 画面が変わっていたので何も送らなかった。もう一度「画面を確認」から選び直すこと。');
        return;
      }
      await this.console.sendKeys(keysToSelect(current.cursor, index));
      this.logger.info(`選択画面で「${option.label}」を選択 id=${snapshotId} by=${byUserId}`);
      await report(`✅ 「${option.label}」を選んだ（by ${byUserId}）`);
    } catch (e) {
      this.logger.warn('選択キーの送信に失敗', e);
      await report(`⚠️ 選択を送れなかった: ${errMessage(e)}`);
    }
  }

  /** 結果を知らせる。押されたメッセージが分かればそれを書き換え、分からなければスレッドに投稿する。投げない */
  private async report(pressed: PressedMessage, message: string): Promise<void> {
    if (pressed.ts) {
      await this.slack
        .updateBlocks(pressed.channel, pressed.ts, message, [plainSection(message)])
        .catch((e: unknown) => this.logger.warn('選択画面の表示の書き換えに失敗', e));
    } else {
      await this.slack.postText(pressed.channel, message, pressed.threadTs).catch(() => undefined);
    }
  }

  private prune(): void {
    const t = this.now();
    for (const [id, s] of this.snapshots) {
      if (t > s.expiresAt) this.snapshots.delete(id);
    }
  }
}

/** 選択画面を Slack に出すブロック。見出し・各選択肢の説明・選択肢のボタン */
export function buildChoiceBlocks(id: string, choice: ChoiceScreen): { text: string; blocks: unknown[] } {
  const heading = redact(choice.title.join('\n')) || '(見出しなし)';
  const details = choice.options
    .map((o, i) => `${i === choice.cursor ? '▶' : '・'} ${o.label}${o.description ? ` — ${o.description}` : ''}`)
    .join('\n');
  const text = `🖥 ターミナルが選択画面で止まっている: ${clip(choice.title[0] ?? '', NOTIFICATION_TITLE_MAX)}`;
  return {
    text,
    blocks: [
      plainSection(clip(`🖥 ターミナルの選択画面\n${heading}`, PLAIN_TEXT_LIMIT)),
      { type: 'context', elements: [{ type: 'plain_text', text: clip(redact(details), PLAIN_TEXT_LIMIT) }] },
      {
        type: 'actions',
        elements: choice.options.map((o, i) => ({
          type: 'button',
          text: { type: 'plain_text', text: clip(redact(o.label), BUTTON_LABEL_MAX) },
          // 同じ actions ブロック内で action_id は重複できないので番号を付ける（受け側は接頭辞で判定）
          action_id: numberedAction(ACTION.SCREEN_PICK, i),
          value: `${id}.${i}`,
        })),
      },
    ],
  };
}
