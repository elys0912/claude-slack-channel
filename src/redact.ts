// ログと画面の中継から伏せる、Slack 固有のトークンの形（I/O なし）。

// Slack のトークン（xox?- 系すべて、xapp-）と Bearer トークンをログから伏せる。
// xox の後ろの 1 文字は種別（b/p/a/e など）で、将来増えても漏れないよう英小文字すべてを対象にする。
const XOX_TOKEN_RE = /xox[a-z]-[\w-]+/g;
const XAPP_TOKEN_RE = /xapp-[\w-]+/g;
const BEARER_RE = /Bearer\s+\S+/g;

/** このチャネルのトークンの形を伏せる（log.ts の redact が、共通の鍵の形と一緒に使う） */
export function redactChannelSecrets(s: string): string {
  return s
    .replace(XOX_TOKEN_RE, 'xox?-***')
    .replace(XAPP_TOKEN_RE, 'xapp-***')
    .replace(BEARER_RE, 'Bearer ***');
}
