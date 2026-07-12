import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAccess, loadHomeCustom, loadTokens, parseDotenv, stateDir } from '../src/config.js';

describe('stateDir', () => {
  it('環境変数があればそれを使う', () => {
    const abs = path.resolve(os.tmpdir(), 'custom', 'dir');
    expect(stateDir({ SLACK_CHANNEL_STATE_DIR: abs } as NodeJS.ProcessEnv)).toBe(abs);
  });

  it('環境変数が相対パスなら絶対パスに解決する', () => {
    const result = stateDir({ SLACK_CHANNEL_STATE_DIR: 'rel/state' } as NodeJS.ProcessEnv);
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.resolve('rel/state'));
  });

  it('環境変数がなければ既定パスを使う', () => {
    const result = stateDir({} as NodeJS.ProcessEnv);
    expect(result).toBe(path.join(os.homedir(), '.claude', 'channels', 'slack'));
  });
});

describe('parseDotenv', () => {
  it('基本的な KEY=VALUE を解釈する', () => {
    expect(parseDotenv('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('コメントと空行を無視する', () => {
    expect(parseDotenv('# comment\n\nFOO=bar\n  # another\n')).toEqual({ FOO: 'bar' });
  });

  it('前後の空白をトリムする', () => {
    expect(parseDotenv('  FOO = bar  \n')).toEqual({ FOO: 'bar' });
  });

  it('ダブルクォート・シングルクォートを剥がす', () => {
    expect(parseDotenv('FOO="bar"\nBAZ=\'qux\'')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('CRLF に対応する', () => {
    expect(parseDotenv('FOO=bar\r\nBAZ=qux\r\n')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('BOM 付きファイルに対応する', () => {
    expect(parseDotenv('\uFEFFFOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('export 接頭辞を許容する', () => {
    expect(parseDotenv('export FOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('空値を許容する', () => {
    expect(parseDotenv('FOO=')).toEqual({ FOO: '' });
  });

  it('値に = を含む場合も最初の = で分割する', () => {
    expect(parseDotenv('FOO=a=b=c')).toEqual({ FOO: 'a=b=c' });
  });

  it('引用符の無い値の後ろの " # ..." は行末コメントとして捨てる', () => {
    expect(parseDotenv('FOO=bar # comment\nBAZ=qux\t# tab')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('値が空で行末コメントだけなら空値にする', () => {
    expect(parseDotenv('FOO= # comment')).toEqual({ FOO: '' });
  });

  it('空白の無い # は値の一部として残す', () => {
    expect(parseDotenv('FOO=a#b')).toEqual({ FOO: 'a#b' });
  });

  it('引用符の中の # は残し、閉じ引用符の後ろのコメントは捨てる', () => {
    expect(parseDotenv('FOO="a # b" # comment\nBAZ=\'c # d\'')).toEqual({
      FOO: 'a # b',
      BAZ: 'c # d',
    });
  });

  it('途中に同じ引用符を含む値は両端の引用符だけを剥がす', () => {
    expect(parseDotenv('FOO="a"b"')).toEqual({ FOO: 'a"b' });
  });

  it('展開や複数行はしない', () => {
    expect(parseDotenv('FOO=$BAR\nBAR=baz')).toEqual({ FOO: '$BAR', BAR: 'baz' });
  });
});

describe('loadTokens', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('正常系: bot/app トークンを読み込める', () => {
    fs.writeFileSync(
      path.join(dir, '.env'),
      'SLACK_BOT_TOKEN=xoxb-TEST-DUMMY\nSLACK_APP_TOKEN=xapp-TEST-DUMMY\n',
    );
    const tokens = loadTokens(dir);
    expect(tokens).toEqual({ botToken: 'xoxb-TEST-DUMMY', appToken: 'xapp-TEST-DUMMY' });
  });

  it('ファイルが無ければ Error', () => {
    expect(() => loadTokens(dir)).toThrow();
  });

  it('DOWNLOAD_DIR があれば絶対パスとして downloadDir に入れる', () => {
    const target = path.join(dir, 'dl');
    fs.writeFileSync(path.join(dir, '.env'), `SLACK_BOT_TOKEN=xoxb-TEST-DUMMY\nSLACK_APP_TOKEN=xapp-TEST-DUMMY\nDOWNLOAD_DIR="${target}"\n`);
    expect(loadTokens(dir).downloadDir).toBe(target);
  });

  it('DOWNLOAD_DIR が無ければ downloadDir は無い', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'SLACK_BOT_TOKEN=xoxb-TEST-DUMMY\nSLACK_APP_TOKEN=xapp-TEST-DUMMY\n');
    expect('downloadDir' in loadTokens(dir)).toBe(false);
  });

  it('DOWNLOAD_DIR が相対パスなら Error', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'SLACK_BOT_TOKEN=xoxb-TEST-DUMMY\nSLACK_APP_TOKEN=xapp-TEST-DUMMY\nDOWNLOAD_DIR=downloads\n');
    expect(() => loadTokens(dir)).toThrow(/DOWNLOAD_DIR/);
  });

  it('bot トークンの接頭辞が誤りなら Error（値を含まない）', () => {
    fs.writeFileSync(
      path.join(dir, '.env'),
      'SLACK_BOT_TOKEN=wrong-prefix-TEST-DUMMY\nSLACK_APP_TOKEN=xapp-TEST-DUMMY\n',
    );
    let caught: unknown;
    try {
      loadTokens(dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain('wrong-prefix-TEST-DUMMY');
    expect(message).toContain('SLACK_BOT_TOKEN');
  });

  it('app トークンの接頭辞が誤りなら Error（値を含まない）', () => {
    fs.writeFileSync(
      path.join(dir, '.env'),
      'SLACK_BOT_TOKEN=xoxb-TEST-DUMMY\nSLACK_APP_TOKEN=wrong-prefix-TEST-DUMMY\n',
    );
    let caught: unknown;
    try {
      loadTokens(dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain('wrong-prefix-TEST-DUMMY');
    expect(message).toContain('SLACK_APP_TOKEN');
  });

  it('process.env を変更しない', () => {
    fs.writeFileSync(
      path.join(dir, '.env'),
      'SLACK_BOT_TOKEN=xoxb-TEST-DUMMY\nSLACK_APP_TOKEN=xapp-TEST-DUMMY\n',
    );
    expect(process.env.SLACK_BOT_TOKEN).toBeUndefined();
    loadTokens(dir);
    expect(process.env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(process.env.SLACK_APP_TOKEN).toBeUndefined();
  });
});

describe('loadAccess', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('正常系', () => {
    fs.writeFileSync(
      path.join(dir, 'access.json'),
      JSON.stringify({ teamId: 'T12345', allowFrom: ['U12345', 'U67890'] }),
    );
    expect(loadAccess(dir)).toEqual({ teamId: 'T12345', allowFrom: ['U12345', 'U67890'] });
  });

  it('channels を読み込める（C と、古い非公開チャンネルの G）', () => {
    fs.writeFileSync(
      path.join(dir, 'access.json'),
      JSON.stringify({ teamId: 'T12345', allowFrom: ['U12345'], channels: ['C12345', 'G12345'] }),
    );
    expect(loadAccess(dir).channels).toEqual(['C12345', 'G12345']);
  });

  it.each([
    ['DM の ID', ['D12345'], /channels のID形式が不正/],
    ['重複', ['C12345', 'C12345'], /channels に重複がある/],
  ])('channels に%sがあれば拒否する', (_label, channels, message) => {
    fs.writeFileSync(
      path.join(dir, 'access.json'),
      JSON.stringify({ teamId: 'T12345', allowFrom: ['U12345'], channels }),
    );
    expect(() => loadAccess(dir)).toThrow(message);
  });

  it('teamId は T で始まるものだけ、allowFrom は U で始まるものだけ受け付ける', () => {
    const write = (v: unknown): void => fs.writeFileSync(path.join(dir, 'access.json'), JSON.stringify(v));
    write({ teamId: 'E12345', allowFrom: ['U12345'] });
    expect(() => loadAccess(dir)).toThrow(/teamId/);
    write({ teamId: 'T12345', allowFrom: ['W12345'] });
    expect(() => loadAccess(dir)).toThrow(/allowFrom/);
  });

  it('未知のキーは拒否する', () => {
    fs.writeFileSync(
      path.join(dir, 'access.json'),
      JSON.stringify({ teamId: 'T12345', allowFrom: ['U12345'], extra: 'nope' }),
    );
    expect(() => loadAccess(dir)).toThrow();
  });

  it('allowFrom が空なら拒否する', () => {
    fs.writeFileSync(
      path.join(dir, 'access.json'),
      JSON.stringify({ teamId: 'T12345', allowFrom: [] }),
    );
    expect(() => loadAccess(dir)).toThrow();
  });

  it('ID の形式が違えば拒否する', () => {
    fs.writeFileSync(
      path.join(dir, 'access.json'),
      JSON.stringify({ teamId: 'bad-id', allowFrom: ['U12345'] }),
    );
    expect(() => loadAccess(dir)).toThrow();
  });

  it('BOM 付きの UTF-8 でも読み込める', () => {
    fs.writeFileSync(
      path.join(dir, 'access.json'),
      '\uFEFF' + JSON.stringify({ teamId: 'T12345', allowFrom: ['U12345'] }),
    );
    expect(loadAccess(dir)).toEqual({ teamId: 'T12345', allowFrom: ['U12345'] });
  });

  it('JSON の構文エラーなら拒否する', () => {
    fs.writeFileSync(path.join(dir, 'access.json'), '{ not valid json');
    expect(() => loadAccess(dir)).toThrow();
  });
});

describe('loadHomeCustom', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-custom-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('無ければ undefined', () => {
    expect(loadHomeCustom(dir)).toBeUndefined();
  });

  it('BOM 付きでも読める', () => {
    fs.writeFileSync(path.join(dir, 'home.json'), '﻿' + JSON.stringify({ greetings: ['やっほー'] }));
    expect(loadHomeCustom(dir)).toEqual({ greetings: ['やっほー'] });
  });

  it('未知のキー・壊れた JSON は投げる', () => {
    fs.writeFileSync(path.join(dir, 'home.json'), JSON.stringify({ greeting: 'typo' }));
    expect(() => loadHomeCustom(dir)).toThrow(/home.json の検証に失敗/);
    fs.writeFileSync(path.join(dir, 'home.json'), '{ broken');
    expect(() => loadHomeCustom(dir)).toThrow();
  });
});
