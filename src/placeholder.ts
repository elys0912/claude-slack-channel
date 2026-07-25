// 「何もしない」slackbridge。ツールも通知も持たない MCP サーバーとして起動し、Claude Code が終わるまで待つだけ。
//
// Claude Code 2.1.289 から、--dangerously-load-development-channels の server:<名前> は、設定ファイル
// （user / project / local など）に同じ名前の MCP サーバーが登録されていないと受け付けなくなった。
// --mcp-config で渡したサーバーは数に入らない。そこで start.ps1 は作業フォルダーの local スコープにも slackbridge を
// 登録する。channel セッションは --strict-mcp-config なので、実際に動くのは --mcp-config の本物のほう。
// 普段のセッション（start.ps1 を通さない）ではこの登録が読み込まれるので、Slack にもロックにも触らない
// このサーバーとして動かす。

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SERVER_NAME, SERVER_VERSION } from './mcp.js';

/** local スコープの登録にだけ付ける環境変数。値が '1' なら main.js はこのサーバーとして動く */
export const PLACEHOLDER_ENV = 'SLACK_CHANNEL_PLACEHOLDER';

export const PLACEHOLDER_INSTRUCTIONS =
  'このセッションは Slack に接続していない（scripts/start.ps1 から起動したときだけ Slack と中継する）。ツールは無い。';

export function isPlaceholder(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PLACEHOLDER_ENV] === '1';
}

/** ツールも通知も持たない MCP サーバー */
export function createPlaceholderServer(): Server {
  return new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: {}, instructions: PLACEHOLDER_INSTRUCTIONS });
}

/** 標準入出力で待ち、Claude Code が終わったら（stdin が閉じたら）抜ける */
export async function runPlaceholder(): Promise<void> {
  const server = createPlaceholderServer();
  const exit = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.stdin.on('end', exit);
  process.stdin.on('close', exit);
  await server.connect(new StdioServerTransport());
}
