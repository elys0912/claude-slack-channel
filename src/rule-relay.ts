// 「♾ 今後も許可」から許可リスト（allow-extra.json）への追加を提案し、確認のうえ書き込む。`!rules` で一覧・削除もする。
// 書き込んだルールは start.ps1 が次の起動時に channel-settings.json の allow へ足す（起動中のセッションには効かない）。
import type { Logger } from './log.js';
import type { PermissionRequest } from './permission.js';
import { AllowRuleStore, denyOverlaps, parseRuleForCheck, proposeRule } from './allow-rules.js';
import { clip, newToken } from './text.js';
import type { PressedMessage } from './types.js';

/** 追加の提案の有効期限 */
const PROPOSAL_TTL_MS = 10 * 60 * 1000;
/** 一覧に並べる削除ボタンの上限（actions ブロックの要素数の上限 25 に収める） */
const LIST_MAX = 20;
/** Slack の button の text の上限（75）に収める */
const BUTTON_LABEL_MAX = 70;

export interface RuleSlack {
  postText(channel: string, text: string, threadTs?: string): Promise<{ ts: string[] }>;
  postBlocks(channel: string, text: string, blocks: unknown[], threadTs?: string): Promise<{ ts: string }>;
  updateBlocks(channel: string, ts: string, text: string, blocks: unknown[]): Promise<void>;
}

export interface RuleRelayOptions {
  store: Pick<AllowRuleStore, 'list' | 'add' | 'remove'>;
  /** その時点の deny（channel-settings.json と作業フォルダーの .claude/settings*.json）。呼ぶたびに読み直す */
  loadDeny: () => string[];
  slack: RuleSlack;
  logger: Logger;
  now?: () => number;
  newId?: () => string;
}

function section(text: string): unknown {
  return { type: 'section', text: { type: 'plain_text', text } };
}

export class RuleRelay {
  private readonly opts: RuleRelayOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly proposals = new Map<string, { rule: string; expiresAt: number }>();

  constructor(opts: RuleRelayOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? newToken;
  }

  /** 実行許可のリクエストから候補を作り、追加してよいかをスレッドで確認する。作れない・deny に当たるならその旨を知らせる。投げない */
  async propose(req: PermissionRequest, channel: string, threadTs: string): Promise<void> {
    const { slack, logger } = this.opts;
    try {
      const result = proposeRule(req, this.opts.loadDeny());
      if (!result.ok) {
        const text = result.denyHits
          ? `🚫 ${result.reason}\n当たった deny: ${result.denyHits.join(', ')}\n（今回の操作は許可した）`
          : `ℹ️ 許可リストには追加しない: ${result.reason}\n（今回の操作は許可した）`;
        logger.info(`許可リストへの追加を見送り tool=${req.tool_name} 理由=${result.reason}`);
        await slack.postText(channel, text, threadTs);
        return;
      }
      if (this.opts.store.list().includes(result.rule)) {
        await slack.postText(channel, `ℹ️ ${result.rule} は既に許可リストにある（次に起動し直したときから有効）`, threadTs);
        return;
      }
      this.prune();
      const id = this.newId();
      this.proposals.set(id, { rule: result.rule, expiresAt: this.now() + PROPOSAL_TTL_MS });
      const text = `♾ 許可リストにこのルールを追加する？ ${result.rule}`;
      await slack.postBlocks(
        channel,
        text,
        [
          section(`♾ 許可リストにこのルールを追加する？\n${result.rule}`),
          {
            type: 'context',
            elements: [{ type: 'plain_text', text: '追加すると、次に起動し直したときから確認なしで実行される。今回の操作は許可済み。' }],
          },
          {
            type: 'actions',
            elements: [
              { type: 'button', text: { type: 'plain_text', text: '追加する' }, style: 'primary', action_id: 'rule_add', value: id },
              { type: 'button', text: { type: 'plain_text', text: 'やめる' }, action_id: 'rule_cancel', value: id },
            ],
          },
        ],
        threadTs
      );
    } catch (e) {
      logger.warn('許可リストの提案に失敗', e);
    }
  }

  /** 追加の提案に答えた。追加する前に deny を読み直して、もう一度照合する。投げない */
  async confirm(proposalId: string, accept: boolean, pressed: PressedMessage, byUserId: string): Promise<void> {
    const proposal = this.proposals.get(proposalId);
    this.proposals.delete(proposalId);
    if (!proposal || this.now() > proposal.expiresAt) {
      await this.report(pressed, '⌛ この提案は期限切れ。もう一度「今後も許可」から提案し直すこと。');
      return;
    }
    if (!accept) {
      await this.report(pressed, `追加しなかった: ${proposal.rule}`);
      return;
    }
    try {
      const parsed = parseRuleForCheck(proposal.rule);
      const hits = parsed ? denyOverlaps(parsed, this.opts.loadDeny()) : [];
      if (hits.length > 0) {
        await this.report(pressed, `🚫 deny に当たるので追加しない: ${proposal.rule}\n当たった deny: ${hits.join(', ')}`);
        return;
      }
      this.opts.store.add(proposal.rule);
      this.opts.logger.info(`許可リストに追加 rule=${proposal.rule} by=${byUserId}`);
      await this.report(pressed, `✅ 許可リストに追加した: ${proposal.rule}（by ${byUserId}）\n次に起動し直したときから有効。取り消すときは !rules から消す。`);
    } catch (e) {
      this.opts.logger.warn('許可リストへの追加に失敗', e);
      await this.report(pressed, `⚠️ 追加できなかった: ${proposal.rule}`);
    }
  }

  /** 追加分のルールを一覧し、削除ボタンを付けて出す。投げない */
  async list(channel: string, threadTs: string): Promise<void> {
    const { slack, logger } = this.opts;
    try {
      const rules = this.opts.store.list();
      if (rules.length === 0) {
        await slack.postText(channel, 'Slack から追加したルールは無い。', threadTs);
        return;
      }
      const shown = rules.slice(0, LIST_MAX);
      const more = rules.length > shown.length ? `\n（ほか ${rules.length - shown.length} 件）` : '';
      await slack.postBlocks(
        channel,
        `Slack から追加したルール ${rules.length} 件`,
        [
          section(`Slack から追加したルール（次に起動し直したときに反映）\n${shown.map((r) => `• ${r}`).join('\n')}${more}`),
          {
            type: 'actions',
            elements: shown.map((r, i) => ({
              type: 'button',
              text: { type: 'plain_text', text: clip(`🗑 ${r}`, BUTTON_LABEL_MAX) },
              action_id: `rule_remove_${i}`,
              value: r,
            })),
          },
        ],
        threadTs
      );
    } catch (e) {
      logger.warn('許可リストの一覧に失敗', e);
    }
  }

  /** 追加分のルールを消す。投げない */
  async remove(rule: string, pressed: PressedMessage, byUserId: string): Promise<void> {
    try {
      const removed = this.opts.store.remove(rule);
      if (removed) this.opts.logger.info(`許可リストから削除 rule=${rule} by=${byUserId}`);
      await this.opts.slack.postText(
        pressed.channel,
        removed ? `🗑 許可リストから消した: ${rule}（次に起動し直したときから反映）` : `ℹ️ 既に無かった: ${rule}`,
        pressed.threadTs
      );
    } catch (e) {
      this.opts.logger.warn('許可リストからの削除に失敗', e);
    }
  }

  private async report(pressed: PressedMessage, text: string): Promise<void> {
    try {
      if (pressed.ts) await this.opts.slack.updateBlocks(pressed.channel, pressed.ts, text, [section(text)]);
      else await this.opts.slack.postText(pressed.channel, text, pressed.threadTs);
    } catch (e) {
      this.opts.logger.warn('許可リストの結果の表示に失敗', e);
    }
  }

  private prune(): void {
    const t = this.now();
    for (const [id, p] of this.proposals) {
      if (t > p.expiresAt) this.proposals.delete(id);
    }
  }
}
