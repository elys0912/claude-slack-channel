// モジュール間で共有する小さな型。アクセス設定の型は config.ts の ParsedAccess（zod から導出）を使う。

// permission relay の判定結果
export type Verdict = {
  requestId: string;
  behavior: 'allow' | 'deny';
};
