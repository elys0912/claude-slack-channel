// 実行許可（permission）リレーの状態管理。
// Claude からの permission_request を Slack の DM に配信し、Slack 側の回答（ボタン / yes・no 返信）を
// Claude へ返して、ボタン付きメッセージを結果表示に書き換える。
import type { Logger } from './log.js';
import type { Verdict } from './types.js';
import {
  PendingPermissions,
  buildExpiredBlocks,
  buildPermissionBlocks,
  buildResolvedBlocks,
} from './permission.js';
import type { PermissionRequest } from './permission.js';

interface MessageRef {
  channel: string;
  ts: string;
}

/** リレーが使う Slack 側の操作（SlackBridge のうち必要な部分だけ） */
export interface RelaySlack {
  postToAll(
    text: string,
    blocks?: unknown[],
    threadFor?: (channel: string) => string | undefined
  ): Promise<MessageRef[]>;
  updateBlocks(channel: string, ts: string, text: string, blocks: unknown[]): Promise<void>;
}

/** リレーが使う Claude 側の操作（ChannelServer のうち必要な部分だけ） */
export interface RelayClaude {
  sendVerdict(v: Verdict): Promise<void>;
}

export class PermissionRelay {
  private readonly slack: RelaySlack;
  private readonly claude: RelayClaude;
  private readonly logger: Logger;
  private readonly pending: PendingPermissions;
  /** request_id → ボタンを出したメッセージ（回答が決まったら結果表示に書き換える） */
  private readonly posted = new Map<string, MessageRef[]>();
  /** DM チャンネル → 最後にメッセージを受け取ったスレッド（確認はそのスレッドに出す） */
  private readonly activeThread = new Map<string, string>();

  constructor(slack: RelaySlack, claude: RelayClaude, logger: Logger, pending = new PendingPermissions()) {
    this.slack = slack;
    this.claude = claude;
    this.logger = logger;
    this.pending = pending;
  }

  /** 会話中のスレッドを覚えておく。次の permission request はそこに投稿される */
  rememberThread(channel: string, threadTs: string): void {
    this.activeThread.set(channel, threadTs);
  }

  /** 期限内の保留中リクエストを返す（See more ボタン用） */
  lookup(requestId: string): PermissionRequest | undefined {
    return this.pending.get(requestId);
  }

  /** Claude からの permission_request を、許可ユーザー全員の DM にボタン付きで配信する */
  async request(req: PermissionRequest): Promise<void> {
    this.pending.prune();
    this.pending.add(req);

    const { text, blocks } = buildPermissionBlocks(req);
    const results = await this.slack.postToAll(text, blocks, (channel) => this.activeThread.get(channel));
    this.posted.set(req.request_id, results.filter((r) => r.ts !== ''));
    this.logger.info(`permission_request を配信 id=${req.request_id} tool=${req.tool_name} 宛先=${results.length}`);
  }

  /**
   * `yes xxxxx` / `no xxxxx` の返信による回答。
   * 手元に記録が無い ID でも Claude 側はまだ待っている可能性があるので、判定はそのまま送る。
   */
  async answerByText(verdict: Verdict, byUserId: string): Promise<void> {
    const req = this.pending.take(verdict.requestId);
    await this.claude.sendVerdict(verdict);
    this.logger.info(
      `verdict を送信 id=${verdict.requestId} behavior=${verdict.behavior} known=${req !== undefined}`
    );
    if (req) await this.markResolved(req, verdict.behavior, byUserId);
  }

  /**
   * Allow / Deny ボタンによる回答。期限切れのボタンは Claude に送らず、
   * 押されたメッセージを「期限切れ」表示に書き換える。
   */
  async answerByButton(verdict: Verdict, byUserId: string, pressed: MessageRef | undefined): Promise<void> {
    const req = this.pending.take(verdict.requestId);
    if (!req) {
      this.logger.warn(`期限切れの permission id=${verdict.requestId}`);
      if (pressed) await this.markExpired(verdict.requestId, pressed);
      return;
    }

    await this.claude.sendVerdict(verdict);
    this.logger.info(`verdict を送信（ボタン） id=${verdict.requestId} behavior=${verdict.behavior}`);
    await this.markResolved(req, verdict.behavior, byUserId);
  }

  /** 配信済みのボタン付きメッセージを、すべて「Allowed / Denied」表示に書き換える */
  private async markResolved(
    req: PermissionRequest,
    behavior: Verdict['behavior'],
    byUserId: string
  ): Promise<void> {
    const targets = this.posted.get(req.request_id) ?? [];
    this.posted.delete(req.request_id);

    const { text, blocks } = buildResolvedBlocks(req, behavior, byUserId);
    for (const t of targets) {
      try {
        await this.slack.updateBlocks(t.channel, t.ts, text, blocks);
      } catch (e) {
        this.logger.warn(`permission メッセージの書き換えに失敗 channel=${t.channel}`, e);
      }
    }
  }

  private async markExpired(requestId: string, message: MessageRef): Promise<void> {
    const { text, blocks } = buildExpiredBlocks(requestId);
    try {
      await this.slack.updateBlocks(message.channel, message.ts, text, blocks);
    } catch (e) {
      this.logger.warn('期限切れ表示への書き換えに失敗', e);
    }
  }
}
