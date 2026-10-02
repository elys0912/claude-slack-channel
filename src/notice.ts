// ブリッジからの知らせ（hook の通知・状態）を Slack に出す。
// 宛先は最後に話しかけられたスレッド。まだ無ければ許可ユーザー全員の DM。投げない。
import type { Logger } from './log.js';
import type { ThreadRef } from './types.js';

export interface NoticeSlack {
  postBlocks(channel: string, text: string, blocks: unknown[], threadTs?: string): Promise<{ ts: string }>;
  postToAll(text: string, blocks?: unknown[]): Promise<{ channel: string; ts: string }[]>;
}

export class NoticePoster {
  private readonly slack: NoticeSlack;
  private readonly threadOf: () => ThreadRef | undefined;
  private readonly logger: Logger;

  constructor(slack: NoticeSlack, threadOf: () => ThreadRef | undefined, logger: Logger) {
    this.slack = slack;
    this.threadOf = threadOf;
    this.logger = logger;
  }

  /** text を知らせる。blocks を省略すれば text だけの section にする */
  async post(text: string, blocks?: unknown[]): Promise<void> {
    const view = blocks ?? [{ type: 'section', text: { type: 'plain_text', text } }];
    const thread = this.threadOf();
    try {
      if (thread) {
        await this.slack.postBlocks(thread.channel, text, view, thread.threadTs);
      } else {
        await this.slack.postToAll(text, view);
      }
    } catch (e) {
      this.logger.warn('知らせの投稿に失敗', e);
    }
  }
}
