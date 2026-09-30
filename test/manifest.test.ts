import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** slack-app-manifest.yaml の oauth_config.scopes.bot を取り出す（依存を増やさないよう行単位で読む） */
function botScopes(): string[] {
  const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'slack-app-manifest.yaml'), 'utf8');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s{4}bot:\s*$/.test(l));
  const scopes: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s{6}-\s+([a-z:.]+)/.exec(line);
    if (!m) break;
    scopes.push(m[1] ?? '');
  }
  return scopes;
}

describe('slack-app-manifest.yaml', () => {
  it('ブリッジと npm run check が呼ぶ Web API に必要な bot スコープがそろっている', () => {
    expect(botScopes().sort()).toEqual([
      'channels:history',
      'chat:write',
      'groups:history',
      'im:history',
      'im:write',
      'reactions:write',
      'users:read',
    ]);
  });
});
