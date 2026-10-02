import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ChannelServer, INSTRUCTIONS, SERVER_NAME } from '../src/mcp.js';
import { Logger } from '../src/log.js';
import type { PermissionRequest } from '../src/permission.js';

interface Captured {
  notifications: { method: string; params?: Record<string, unknown> }[];
  permissionRequests: PermissionRequest[];
  replies: unknown[];
  reacts: unknown[];
  edits: unknown[];
}

async function connect(
  overrides: Partial<{
    onReply: (a: { chat_id: string; text: string; thread_ts?: string | undefined }) => Promise<string>;
    onDownload: (a: { file_id: string; extract?: boolean | undefined }) => Promise<string>;
  }> = {}
): Promise<{ client: Client; server: ChannelServer; captured: Captured }> {
  const captured: Captured = {
    notifications: [],
    permissionRequests: [],
    replies: [],
    reacts: [],
    edits: [],
  };

  const server = new ChannelServer({
    logger: new Logger({ stderr: false }),
    onReply:
      overrides.onReply ??
      (async (a) => {
        captured.replies.push(a);
        return 'sent (1 message(s))';
      }),
    onReact: async (a) => {
      captured.reacts.push(a);
      return 'reacted';
    },
    onEdit: async (a) => {
      captured.edits.push(a);
      return 'edited';
    },
    onPermissionRequest: (req) => {
      captured.permissionRequests.push(req);
    },
    onDownload: overrides.onDownload,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
  client.fallbackNotificationHandler = async (n) => {
    captured.notifications.push(n as { method: string; params?: Record<string, unknown> });
  };

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server, captured };
}

describe('ChannelServer の initialize', () => {
  it('channel / permission / tools の capabilities を出す', async () => {
    const { client, server } = await connect();
    const caps = client.getServerCapabilities();
    expect(caps?.experimental).toBeDefined();
    expect(caps?.experimental?.['claude/channel']).toEqual({});
    expect(caps?.experimental?.['claude/channel/permission']).toEqual({});
    expect(caps?.tools).toEqual({});
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    await client.close();
    await server.close();
  });

  it('instructions に安全上の規則が含まれる', () => {
    expect(INSTRUCTIONS).toContain('reply');
    expect(INSTRUCTIONS).toContain('access.json');
    expect(INSTRUCTIONS).toContain('トークン');
    expect(INSTRUCTIONS).toContain('データ');
  });
});

describe('ChannelServer の tools', () => {
  it('onDownload があれば download_file を出し、引数を渡して呼ぶ', async () => {
    const calls: unknown[] = [];
    const { client } = await connect({
      onDownload: async (a) => {
        calls.push(a);
        return 'saved: x';
      },
    });
    const res = await client.listTools();
    expect(res.tools.map((t) => t.name).sort()).toEqual(['download_file', 'edit_message', 'react', 'reply']);
    expect(res.tools.find((t) => t.name === 'download_file')?.inputSchema.required).toEqual(['file_id']);

    const out = await client.callTool({ name: 'download_file', arguments: { file_id: 'F1AAA', extract: true } });
    expect(out.content).toEqual([{ type: 'text', text: 'saved: x' }]);
    expect(calls).toEqual([{ file_id: 'F1AAA', extract: true }]);
  });

  it('onDownload が無ければ download_file は出さず、呼ばれてもエラー', async () => {
    const { client } = await connect();
    const out = await client.callTool({ name: 'download_file', arguments: { file_id: 'F1AAA' } });
    expect(out.isError).toBe(true);
  });

  it('reply / react / edit_message を出す', async () => {
    const { client, server } = await connect();
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name).sort();
    expect(names).toEqual(['edit_message', 'react', 'reply']);

    const reply = res.tools.find((t) => t.name === 'reply');
    expect(reply?.inputSchema.type).toBe('object');
    expect(Object.keys(reply?.inputSchema.properties ?? {}).sort()).toEqual([
      'chat_id',
      'text',
      'thread_ts',
    ]);
    expect(reply?.inputSchema.required).toEqual(['chat_id', 'text']);

    const react = res.tools.find((t) => t.name === 'react');
    expect(Object.keys(react?.inputSchema.properties ?? {}).sort()).toEqual([
      'chat_id',
      'emoji',
      'message_id',
    ]);
    await client.close();
    await server.close();
  });

  it('reply を呼ぶとハンドラに渡り、結果が返る', async () => {
    const { client, server, captured } = await connect();
    const res = await client.callTool({
      name: 'reply',
      arguments: { chat_id: 'D1', text: 'hi', thread_ts: '1.0' },
    });
    expect(captured.replies[0]).toEqual({ chat_id: 'D1', text: 'hi', thread_ts: '1.0' });
    expect(res.content).toEqual([{ type: 'text', text: 'sent (1 message(s))' }]);
    await client.close();
    await server.close();
  });

  it('react / edit_message も渡る', async () => {
    const { client, server, captured } = await connect();
    await client.callTool({ name: 'react', arguments: { chat_id: 'D1', message_id: '1.1', emoji: 'eyes' } });
    await client.callTool({
      name: 'edit_message',
      arguments: { chat_id: 'D1', message_id: '1.1', text: 'new' },
    });
    expect(captured.reacts[0]).toEqual({ chat_id: 'D1', message_id: '1.1', emoji: 'eyes' });
    expect(captured.edits[0]).toEqual({ chat_id: 'D1', message_id: '1.1', text: 'new' });
    await client.close();
    await server.close();
  });

  it('引数が足りなければ isError を返して例外は投げない', async () => {
    const { client, server } = await connect();
    const res = await client.callTool({ name: 'reply', arguments: { chat_id: 'D1' } });
    expect(res.isError).toBe(true);
    await client.close();
    await server.close();
  });

  it('ハンドラが投げても isError になる', async () => {
    const { client, server } = await connect({
      onReply: async () => {
        throw new Error('slack down');
      },
    });
    const res = await client.callTool({ name: 'reply', arguments: { chat_id: 'D1', text: 'hi' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('slack down');
    await client.close();
    await server.close();
  });
});

describe('ChannelServer の通知', () => {
  it('pushMessage が notifications/claude/channel を送る', async () => {
    const { client, server, captured } = await connect();
    await server.pushMessage('hello', { chat_id: 'D1', 'bad-key': 'x', ok_key: 'y' });
    await new Promise((r) => setTimeout(r, 20));

    const n = captured.notifications.find((x) => x.method === 'notifications/claude/channel');
    expect(n).toBeDefined();
    expect(n?.params?.content).toBe('hello');
    expect(n?.params?.meta).toEqual({ chat_id: 'D1', ok_key: 'y' });
    await client.close();
    await server.close();
  });

  it('sendVerdict が notifications/claude/channel/permission を送る', async () => {
    const { client, server, captured } = await connect();
    await server.sendVerdict({ requestId: 'abcde', behavior: 'deny' });
    await new Promise((r) => setTimeout(r, 20));

    const n = captured.notifications.find(
      (x) => x.method === 'notifications/claude/channel/permission'
    );
    expect(n?.params).toEqual({ request_id: 'abcde', behavior: 'deny' });
    await client.close();
    await server.close();
  });

  it('permission_request の通知でハンドラが呼ばれる', async () => {
    const { client, server, captured } = await connect();
    await client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: {
        request_id: 'abcde',
        tool_name: 'Bash',
        description: 'Run shell command',
        input_preview: '{"command":"ls"}',
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(captured.permissionRequests[0]).toEqual({
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Run shell command',
      input_preview: '{"command":"ls"}',
    });
    await client.close();
    await server.close();
  });

  it.each(['ABCDE', 'abcdl', 'abcd', 'abcdef', '<!here>'])(
    'request_id が不正（%s）なら Slack 側に渡さず、warn して deny を返す',
    async (requestId) => {
      const { client, server, captured } = await connect();
      await client.notification({
        method: 'notifications/claude/channel/permission_request',
        params: { request_id: requestId, tool_name: 'Bash', description: 'd', input_preview: 'p' },
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(captured.permissionRequests).toHaveLength(0);
      const verdicts = captured.notifications.filter(
        (x) => x.method === 'notifications/claude/channel/permission'
      );
      expect(verdicts.map((v) => v.params)).toEqual([{ request_id: requestId, behavior: 'deny' }]);
      await client.close();
      await server.close();
    }
  );
});
