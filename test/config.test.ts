import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadAccess, loadHomeCustom, loadTokens, parseDotenv, stateDir } from '../src/config.js';
import { useTempDir } from './helpers/temp-dir.js';

/** 形の正しい bot / app トークンの 2 行 */
const VALID_TOKENS = 'SLACK_BOT_TOKEN=xoxb-TEST-DUMMY\nSLACK_APP_TOKEN=xapp-TEST-DUMMY\n';

function writeDotenv(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, '.env'), content);
}

/** 正しいトークンの 2 行の後ろに extra を足した .env を書く */
function writeEnv(dir: string, extra = ''): void {
  writeDotenv(dir, VALID_TOKENS + extra);
}

function writeAccess(dir: string, access: unknown): void {
  fs.writeFileSync(path.join(dir, 'access.json'), JSON.stringify(access));
}

/** fn が投げた Error の message。Error を投げなければテストを失敗させる */
function errorMessageOf(fn: () => unknown): string {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);

  return (caught as Error).message;
}

describe('stateDir', () => {
  it('環境変数があればそれを使う', () => {
    const abs = path.resolve(os.tmpdir(), 'custom', 'dir');
    expect(stateDir({ SLACK_CHANNEL_STATE_DIR: abs })).toBe(abs);
  });

  it('環境変数が相対パスなら絶対パスに解決する', () => {
    const result = stateDir({ SLACK_CHANNEL_STATE_DIR: 'rel/state' });
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.resolve('rel/state'));
  });

  it('環境変数がなければ既定パスを使う', () => {
    const result = stateDir({});
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
  const tempDir = useTempDir('config-test-');
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  it('正常系: bot/app トークンを読み込める', () => {
    writeEnv(dir);
    const tokens = loadTokens(dir);
    expect(tokens).toEqual({
      botToken: 'xoxb-TEST-DUMMY',
      appToken: 'xapp-TEST-DUMMY',
      keepalive: { enabled: true, afterMin: 55, max: 6, quiet: { start: 60, end: 420 } },
      usageWatch: { enabled: true, usageWarnPct: [80, 95], contextWarnPct: [70, 90] },
    });
  });

  it('USAGE_WATCH としきい値を読み、しきい値が空なら知らせない', () => {
    writeEnv(dir, 'USAGE_WATCH=off\nUSAGE_WARN_PCT=90,50\nCONTEXT_WARN_PCT=\n');
    expect(loadTokens(dir).usageWatch).toEqual({ enabled: false, usageWarnPct: [50, 90], contextWarnPct: [] });
  });

  it.each([
    ['しきい値が範囲外', 'USAGE_WARN_PCT=101\n', /USAGE_WARN_PCT/],
    ['USAGE_WATCH が on / off 以外', 'USAGE_WATCH=maybe\n', /USAGE_WATCH は on か off/],
  ])('%s なら投げる', (_label, extra, message) => {
    writeEnv(dir, extra);
    expect(() => loadTokens(dir)).toThrow(message);
  });

  it('KEEPALIVE の設定を読み、off・時間帯なしを扱う', () => {
    writeEnv(dir, 'KEEPALIVE=off\nKEEPALIVE_AFTER_MIN=50\nKEEPALIVE_MAX=3\nKEEPALIVE_QUIET=\n');
    expect(loadTokens(dir).keepalive).toEqual({ enabled: false, afterMin: 50, max: 3, quiet: undefined });
  });

  it.each([
    ['KEEPALIVE_AFTER_MIN が範囲外', 'KEEPALIVE_AFTER_MIN=60\n', /KEEPALIVE_AFTER_MIN/],
    ['KEEPALIVE_QUIET の形が違う', 'KEEPALIVE_QUIET=1-7\n', /KEEPALIVE_QUIET/],
    ['KEEPALIVE が on / off 以外', 'KEEPALIVE=maybe\n', /KEEPALIVE は on か off/],
  ])('%s なら投げる', (_label, extra, message) => {
    writeEnv(dir, extra);
    expect(() => loadTokens(dir)).toThrow(message);
  });

  it('ファイルが無ければ Error', () => {
    expect(() => loadTokens(dir)).toThrow();
  });

  it('DOWNLOAD_DIR があれば絶対パスとして downloadDir に入れる', () => {
    const target = path.join(dir, 'dl');
    writeEnv(dir, `DOWNLOAD_DIR="${target}"\n`);
    expect(loadTokens(dir).downloadDir).toBe(target);
  });

  it.each([
    ['on', true],
    ['ON', true],
    ['true', true],
    ['1', true],
    ['off', false],
    ['0', false],
    ['none', false],
    ['only', false],
    ['', false],
  ])('SESSION_ALLOW_ALL=%s なら「全部許可」を使えるのは %s', (value, expected) => {
    writeEnv(dir, `SESSION_ALLOW_ALL=${value}\n`);
    expect(loadTokens(dir).sessionAllowAll === true).toBe(expected);
  });

  it('SESSION_ALLOW_ALL が on / off 以外なら、起動は止めずに off にして知らせる', () => {
    writeEnv(dir, 'SESSION_ALLOW_ALL=yes\n');
    const warnings: string[] = [];
    expect('sessionAllowAll' in loadTokens(dir, (m) => warnings.push(m))).toBe(false);
    expect(warnings).toEqual(['.env の SESSION_ALLOW_ALL の値（3 文字）は on / off のどちらでもないので off にした']);
  });

  it('SESSION_ALLOW_ALL が無ければ「全部許可」は使えない', () => {
    writeEnv(dir);
    expect('sessionAllowAll' in loadTokens(dir)).toBe(false);
  });

  it('DOWNLOAD_DIR が無ければ downloadDir は無い', () => {
    writeEnv(dir);
    expect('downloadDir' in loadTokens(dir)).toBe(false);
  });

  it('DOWNLOAD_DIR が相対パスなら Error', () => {
    writeEnv(dir, 'DOWNLOAD_DIR=downloads\n');
    expect(() => loadTokens(dir)).toThrow(/DOWNLOAD_DIR/);
  });

  it('bot トークンの接頭辞が誤りなら Error（値を含まない）', () => {
    writeDotenv(dir, 'SLACK_BOT_TOKEN=wrong-prefix-TEST-DUMMY\nSLACK_APP_TOKEN=xapp-TEST-DUMMY\n');
    const message = errorMessageOf(() => loadTokens(dir));
    expect(message).not.toContain('wrong-prefix-TEST-DUMMY');
    expect(message).toContain('SLACK_BOT_TOKEN');
  });

  it('app トークンの接頭辞が誤りなら Error（値を含まない）', () => {
    writeDotenv(dir, 'SLACK_BOT_TOKEN=xoxb-TEST-DUMMY\nSLACK_APP_TOKEN=wrong-prefix-TEST-DUMMY\n');
    const message = errorMessageOf(() => loadTokens(dir));
    expect(message).not.toContain('wrong-prefix-TEST-DUMMY');
    expect(message).toContain('SLACK_APP_TOKEN');
  });

  it('process.env を変更しない', () => {
    writeEnv(dir);
    expect(process.env.SLACK_BOT_TOKEN).toBeUndefined();
    loadTokens(dir);
    expect(process.env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(process.env.SLACK_APP_TOKEN).toBeUndefined();
  });
});

describe('loadAccess', () => {
  const tempDir = useTempDir('config-test-');
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  it('正常系', () => {
    writeAccess(dir, { teamId: 'T12345', allowFrom: ['U12345', 'U67890'] });
    expect(loadAccess(dir)).toEqual({ teamId: 'T12345', allowFrom: ['U12345', 'U67890'] });
  });

  it('channels を読み込める（C と、古い非公開チャンネルの G）', () => {
    writeAccess(dir, { teamId: 'T12345', allowFrom: ['U12345'], channels: ['C12345', 'G12345'] });
    expect(loadAccess(dir).channels).toEqual(['C12345', 'G12345']);
  });

  it.each([
    ['DM の ID', ['D12345'], /channels のID形式が不正/],
    ['重複', ['C12345', 'C12345'], /channels に重複がある/],
  ])('channels に%sがあれば拒否する', (_label, channels, message) => {
    writeAccess(dir, { teamId: 'T12345', allowFrom: ['U12345'], channels });
    expect(() => loadAccess(dir)).toThrow(message);
  });

  it('teamId は T で始まるものだけ、allowFrom は U で始まるものだけ受け付ける', () => {
    writeAccess(dir, { teamId: 'E12345', allowFrom: ['U12345'] });
    expect(() => loadAccess(dir)).toThrow(/teamId/);
    writeAccess(dir, { teamId: 'T12345', allowFrom: ['W12345'] });
    expect(() => loadAccess(dir)).toThrow(/allowFrom/);
  });

  it('未知のキーは拒否する', () => {
    writeAccess(dir, { teamId: 'T12345', allowFrom: ['U12345'], extra: 'nope' });
    expect(() => loadAccess(dir)).toThrow();
  });

  it('allowFrom が空なら拒否する', () => {
    writeAccess(dir, { teamId: 'T12345', allowFrom: [] });
    expect(() => loadAccess(dir)).toThrow();
  });

  it('ID の形式が違えば拒否する', () => {
    writeAccess(dir, { teamId: 'bad-id', allowFrom: ['U12345'] });
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
  const tempDir = useTempDir('home-custom-');
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  it('無ければ undefined', () => {
    expect(loadHomeCustom(dir)).toBeUndefined();
  });

  it('BOM 付きでも読める', () => {
    fs.writeFileSync(path.join(dir, 'home.json'), '\uFEFF' + JSON.stringify({ greetings: ['やっほー'] }));
    expect(loadHomeCustom(dir)).toEqual({ greetings: ['やっほー'] });
  });

  it('未知のキーは投げる', () => {
    fs.writeFileSync(path.join(dir, 'home.json'), JSON.stringify({ greeting: 'typo' }));
    expect(() => loadHomeCustom(dir)).toThrow(/home.json の検証に失敗/);
  });

  it('壊れた JSON は投げる', () => {
    fs.writeFileSync(path.join(dir, 'home.json'), '{ broken');
    expect(() => loadHomeCustom(dir)).toThrow();
  });
});

describe('config/channel-settings.json', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config', 'channel-settings.json'), 'utf8')) as {
    permissions: { allow: string[] };
  };

  it('Glob / Grep のツール全体を allow に入れない（path でプロジェクトの外を指せるので、Read(./**) の範囲に任せる）', () => {
    expect(settings.permissions.allow).not.toContain('Glob');
    expect(settings.permissions.allow).not.toContain('Grep');
    expect(settings.permissions.allow).toContain('Read(./**)');
  });
});
