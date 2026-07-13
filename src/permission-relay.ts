// 実行許可（permission）リレーの状態管理。
// Claude からの permission_request を、最後に話しかけられたスレッド（DM でもチャンネルでも）に返信として投稿し
// （まだ話しかけられていない・返信に失敗したときは DM に配信し）、Slack 側の回答（ボタン / yes・no 返信）を
// Claude へ返して、ボタン付きメッセージを結果表示に書き換える。
// 回答が無いまま有効期限を過ぎたものは、Claude Code を待たせ続けないよう自動で deny を返す。
import type { Logger } from './log.js';
import type { Verdict } from './types.js';
import {
  PendingPermissions,
  buildAutoDeniedBlocks,
  buildExpiredBlocks,
  buildPermissionBlocks,
  buildResolvedBlocks,
  buildVerdictFailedBlocks,
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
  postBlocks(channel: string, text: string, blocks: unknown[], threadTs?: string): Promise<{ ts: string }>;
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
  /** チャンネル → 最後にメッセージを受け取ったスレッド（DM に配信するときはそのスレッドに出す） */
  private readonly activeThread = new Map<string, string>();
  /** 最後にメッセージを受け取ったスレッド。permission request はまずここに返信する */
  private lastThread: { channel: string; threadTs: string } | undefined;
  /**
   * request_id → 期限切れで自動 deny するタイマー。ここにある ID はまだ Claude に回答を送っていない。
   * 回答を送ったら消す（期限切れのあとに押されたボタンなど、送らなかった回答では消さない）。
   */
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(slack: RelaySlack, claude: RelayClaude, logger: Logger, pending = new PendingPermissions()) {
    this.slack = slack;
    this.claude = claude;
    this.logger = logger;
    this.pending = pending;
  }

  /** 会話中のスレッドを覚えておく。次の permission request はそこに返信される */
  rememberThread(channel: string, threadTs: string): void {
    this.activeThread.set(channel, threadTs);
    this.lastThread = { channel, threadTs };
  }

  /** 期限内の保留中リクエストを返す（See more ボタン用） */
  lookup(requestId: string): PermissionRequest | undefined {
    return this.pending.get(requestId);
  }

  /**
   * Claude からの permission_request を、最後に話しかけられたスレッドにボタン付きで返信する。
   * まだ話しかけられていない・返信に失敗したときは、許可ユーザー全員の DM に配信する。
   * 1 件も届かなかった（全チャンネルで失敗・DM チャンネルが無い）ときは、誰も答えられないので
   * その場で Claude に deny を返す。投げない。
   */
  async request(req: PermissionRequest): Promise<void> {
    this.pending.prune();
    // 同じ ID が再び届いても（再送など）、既に出しているボタンで答えられるので出し直さない
    if (this.pending.get(req.request_id)) {
      this.logger.warn(`保留中の permission_request と同じ ID が届いたので無視する id=${req.request_id}`);
      return;
    }
    this.pending.add(req);
    this.startExpiryTimer(req.request_id);

    const { text, blocks } = buildPermissionBlocks(req);
    const target = this.lastThread;
    if (target) {
      try {
        const res = await this.slack.postBlocks(target.channel, text, blocks, target.threadTs);
        if (res.ts !== '') {
          this.posted.set(req.request_id, [{ channel: target.channel, ts: res.ts }]);
          this.logger.info(
            `permission_request をスレッドに返信 id=${req.request_id} tool=${req.tool_name} channel=${target.channel}`
          );
          return;
        }
      } catch (e) {
        this.logger.warn(`permission_request のスレッド返信に失敗、DM に配信する channel=${target.channel}`, e);
      }
    }

    let results: MessageRef[] = [];
    try {
      results = await this.slack.postToAll(text, blocks, (channel) => this.activeThread.get(channel));
    } catch (e) {
      this.logger.error(`permission_request の配信で例外 id=${req.request_id}`, e);
    }
    const delivered = results.filter((r) => r.ts !== '');
    this.posted.set(req.request_id, delivered);

    if (delivered.length === 0) {
      this.logger.error(`permission_request をどの DM にも配信できなかった id=${req.request_id} 宛先=${results.length}`);
      await this.autoDeny(req.request_id, '配信失敗');
      return;
    }
    this.logger.info(
      `permission_request を配信 id=${req.request_id} tool=${req.tool_name} 成功=${delivered.length}/${results.length}`
    );
  }

  /**
   * `yes xxxxx` / `no xxxxx` の返信による回答。手元に記録が無い（期限切れ・未知の）ID は Claude に送らない。
   * 送ろうとしたら true を返す（送信に失敗したときも true。失敗はメッセージの書き換えで知らせる）。
   */
  async answerByText(verdict: Verdict, byUserId: string): Promise<boolean> {
    const req = this.pending.take(verdict.requestId);
    if (!req) {
      this.logger.warn(`記録の無い permission id=${verdict.requestId} への返信は送らない`);
      return false;
    }
    await this.deliverVerdict(req, verdict, byUserId, 'テキスト');
    return true;
  }

  /**
   * Allow / Deny ボタンによる回答。期限切れのボタンは Claude に送らず、
   * 押されたメッセージを「期限切れ」表示に書き換える（Claude への deny は期限切れのタイマーが送る）。
   */
  async answerByButton(verdict: Verdict, byUserId: string, pressed: MessageRef | undefined): Promise<void> {
    const req = this.pending.take(verdict.requestId);
    if (!req) {
      this.logger.warn(`期限切れの permission id=${verdict.requestId}`);
      if (pressed) await this.markExpired(verdict.requestId, pressed);
      return;
    }
    await this.deliverVerdict(req, verdict, byUserId, 'ボタン');
  }

  /**
   * 保留から取り出した回答を Claude に送り、配信済みのメッセージを結果表示に書き換える。
   * 送れなかったとき（MCP の切断など）は投げず、メッセージを「送れなかった」表示にして知らせる
   * （保留には戻さない。Claude 側に届いていない以上、この ID に答え直す手段は無い）。
   */
  private async deliverVerdict(req: PermissionRequest, verdict: Verdict, byUserId: string, how: string): Promise<void> {
    this.clearExpiryTimer(verdict.requestId);
    try {
      await this.claude.sendVerdict(verdict);
    } catch (e) {
      this.logger.error(`verdict の送信に失敗（${how}） id=${verdict.requestId} behavior=${verdict.behavior}`, e);
      await this.rewritePosted(req.request_id, buildVerdictFailedBlocks(req.request_id, verdict.behavior));
      return;
    }
    this.logger.info(`verdict を送信（${how}） id=${verdict.requestId} behavior=${verdict.behavior}`);
    await this.rewritePosted(req.request_id, buildResolvedBlocks(req, verdict.behavior, byUserId));
  }

  /**
   * まだ回答を送っていない全リクエストに deny を返し、配信済みのメッセージを自動拒否の表示に書き換える（終了時用）。
   * 1 件ずつベストエフォートで、失敗はログに残して続ける。投げない。
   */
  async denyAll(reason: string): Promise<void> {
    for (const requestId of [...this.expiryTimers.keys()]) {
      await this.autoDeny(requestId, reason);
    }
  }

  private startExpiryTimer(requestId: string): void {
    this.clearExpiryTimer(requestId);
    const timer = setTimeout(() => {
      void this.autoDeny(requestId, '期限切れ');
    }, this.pending.ttl);
    timer.unref?.();
    this.expiryTimers.set(requestId, timer);
  }

  private clearExpiryTimer(requestId: string): void {
    const timer = this.expiryTimers.get(requestId);
    if (timer !== undefined) clearTimeout(timer);
    this.expiryTimers.delete(requestId);
  }

  /**
   * まだ回答を送っていないリクエストに、Claude へ deny を送って保留から消し、配信済みのメッセージを
   * 自動拒否の表示に書き換える。回答済みなら何もしない（二重に送らない）。失敗しても投げない。
   */
  private async autoDeny(requestId: string, reason: string): Promise<void> {
    if (!this.expiryTimers.has(requestId)) return;
    this.clearExpiryTimer(requestId);
    this.pending.remove(requestId);

    try {
      await this.claude.sendVerdict({ requestId, behavior: 'deny' });
      this.logger.info(`${reason}のため deny を送信 id=${requestId}`);
    } catch (e) {
      this.logger.error(`自動 deny の送信に失敗 id=${requestId}`, e);
    }
    await this.rewritePosted(requestId, buildAutoDeniedBlocks(requestId, reason));
  }

  /** 配信済みのボタン付きメッセージをすべて書き換え、配信先の記録を消す。失敗はログに残して続ける */
  private async rewritePosted(requestId: string, view: { text: string; blocks: unknown[] }): Promise<void> {
    const targets = this.posted.get(requestId) ?? [];
    this.posted.delete(requestId);
    for (const t of targets) {
      try {
        await this.slack.updateBlocks(t.channel, t.ts, view.text, view.blocks);
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
      this.logger.warn(`期限切れ表示への書き換えに失敗 channel=${message.channel}`, e);
    }
  }
}
