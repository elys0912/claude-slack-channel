// MCP の Client を in-memory トランスポートでサーバーにつなぐテスト用の部品（mcp.test.ts / app.test.ts で共用）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

export interface Notification {
  method: string;
  params?: Record<string, unknown>;
}

export interface LinkedClient {
  client: Client;
  /** client が受け取った通知（届いた順） */
  notifications: Notification[];
  /** サーバー側に渡すトランスポート */
  serverTransport: InMemoryTransport;
  /** client をつなぐ。サーバーが serverTransport につながってから呼ぶ */
  connect: () => Promise<void>;
}

/** サーバーにつなぐ前の Client と、受け取った通知を集める配列を作る */
export function linkClient(): LinkedClient {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
  const notifications: Notification[] = [];
  client.fallbackNotificationHandler = async (n) => {
    notifications.push(n as Notification);
  };
  return { client, notifications, serverTransport, connect: () => client.connect(clientTransport) };
}

export interface PermissionRequestParams {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

/** permission_request の既定の中身（Bash の ls） */
export const BASH_LS_REQUEST: PermissionRequestParams = {
  request_id: 'abcde',
  tool_name: 'Bash',
  description: 'Run shell command',
  input_preview: '{"command":"ls"}',
};

/** Claude Code 側から permission_request の通知を送る。届くのは待たない */
export async function notifyPermissionRequest(client: Client, params: Partial<PermissionRequestParams> = {}): Promise<void> {
  await client.notification({
    method: 'notifications/claude/channel/permission_request',
    params: { ...BASH_LS_REQUEST, ...params },
  });
}
