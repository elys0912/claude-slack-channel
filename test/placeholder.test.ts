import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PLACEHOLDER_ENV, createPlaceholderServer, isPlaceholder } from '../src/placeholder.js';
import { SERVER_NAME } from '../src/mcp.js';

describe('placeholder', () => {
  it('環境変数が 1 のときだけ待つだけのサーバーとして動く', () => {
    expect(isPlaceholder({ [PLACEHOLDER_ENV]: '1' })).toBe(true);
    expect(isPlaceholder({})).toBe(false);
    expect(isPlaceholder({ [PLACEHOLDER_ENV]: '0' })).toBe(false);
    expect(isPlaceholder({ [PLACEHOLDER_ENV]: 'true' })).toBe(false);
  });

  it('slackbridge の名前で接続でき、ツールもチャンネルも持たない', async () => {
    const server = createPlaceholderServer();
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    const caps = client.getServerCapabilities() ?? {};
    expect(caps.tools).toBeUndefined();
    expect(caps.experimental).toBeUndefined();
    expect(client.getInstructions()).toContain('Slack に接続していない');

    await client.close();
    await server.close();
  });
});
