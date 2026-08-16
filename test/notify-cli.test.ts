import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { sendNotice } from '../src/notify-cli.js';
import { ACCESS, makeWeb } from './helpers/fake-slack.js';
import { useTempDir } from './helpers/temp-dir.js';

describe('sendNotice', () => {
  const tempDir = useTempDir('notify-cli-test-');
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
    fs.writeFileSync(path.join(dir, '.env'), 'SLACK_BOT_TOKEN=xoxb-TEST-DUMMY\nSLACK_APP_TOKEN=xapp-TEST-DUMMY\n');
    fs.writeFileSync(path.join(dir, 'access.json'), JSON.stringify(ACCESS));
  });

  it('許可ユーザー全員の DM に送り、送れた数を返す', async () => {
    const web = makeWeb();
    expect(await sendNotice(dir, '🛑 起動し直しを諦めた', web)).toBe(ACCESS.allowFrom.length);
    const posts = web.calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts).toHaveLength(ACCESS.allowFrom.length);
    expect(String(posts[0]?.args.markdown_text ?? posts[0]?.args.text)).toBe('🛑 起動し直しを諦めた');
  });

  it('.env が無ければ投げる', async () => {
    fs.rmSync(path.join(dir, '.env'));
    await expect(sendNotice(dir, 'x', makeWeb())).rejects.toThrow(/\.env/);
  });
});
