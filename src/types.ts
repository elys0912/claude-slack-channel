// モジュール間で共有する小さな型。アクセス設定の型は config.ts の ParsedAccess（zod から導出）を使う。

// permission relay の判定結果
export type Verdict = {
  requestId: string;
  behavior: 'allow' | 'deny';
};

/** 会話しているスレッド（スレッド外の会話なら threadTs は最初のメッセージの ts） */
export interface ThreadRef {
  channel: string;
  threadTs: string;
}

/** ボタンが押されたメッセージの位置。ts が無ければ（押されたメッセージを特定できなければ）結果はスレッドに投稿する */
export interface PressedMessage {
  channel: string;
  ts?: string | undefined;
  threadTs: string;
}
