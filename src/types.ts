// Slack ワークスペース(T...)とDM許可ユーザー(U...)の設定
export interface AccessConfig {
  teamId: string;
  allowFrom: string[];
}

// permission relay の判定結果
export type Verdict = {
  requestId: string;
  behavior: 'allow' | 'deny';
};
