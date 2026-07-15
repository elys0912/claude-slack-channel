import { describe, expect, it } from 'vitest';
import { SessionAllowAll, matchingRule } from '../src/session-allow.js';
import type { PermissionRequest } from '../src/permission.js';

function req(tool: string, input: unknown): PermissionRequest {
  return {
    request_id: 'abcde',
    tool_name: tool,
    description: '',
    input_preview: typeof input === 'string' ? input : JSON.stringify(input),
  };
}

describe('matchingRule', () => {
  it('ツール全体のルールは、そのツールの全リクエストに当たる', () => {
    expect(matchingRule(req('WebFetch', { url: 'https://example.com' }), ['WebFetch'])).toBe('WebFetch');
    expect(matchingRule(req('mcp__a__b', {}), ['mcp__a__b'])).toBe('mcp__a__b');
  });

  it('シェルの中身付きルールは、コマンドがプレフィックスで始まるときだけ当たる', () => {
    const rules = ['Bash(git push:*)', 'PowerShell(Remove-Item *)'];
    expect(matchingRule(req('Bash', { command: 'git push origin main' }), rules)).toBe('Bash(git push:*)');
    expect(matchingRule(req('Bash', { command: 'git status' }), rules)).toBeUndefined();
    expect(matchingRule(req('PowerShell', { command: 'remove-item foo' }), rules)).toBe('PowerShell(Remove-Item *)');
  });

  it('シェルでコマンドが読めなければ、安全側に倒して当たりにする', () => {
    expect(matchingRule(req('Bash', '{"command":"git pu…'), ['Bash(git push:*)'])).toBe('Bash(git push:*)');
  });

  it('Read / Edit のルールは、それが効くツール全部に当たる（中身付きは安全側に倒して当たり）', () => {
    expect(matchingRule(req('Grep', { pattern: 'x' }), ['Read(./.env)'])).toBe('Read(./.env)');
    expect(matchingRule(req('Write', { file_path: 'C:\\a.txt' }), ['Edit(//c/**)'])).toBe('Edit(//c/**)');
    expect(matchingRule(req('Write', { file_path: 'C:\\a.txt' }), ['Read(//c/**)'])).toBeUndefined();
  });

  it('関係ないツールのルールには当たらない', () => {
    expect(matchingRule(req('Bash', { command: 'ls' }), ['WebFetch', 'Read(.env)', 'not a rule('])).toBeUndefined();
  });
});

describe('matchingRule（パスの ask ルール）', () => {
  const ctx = { workDir: 'C:\\dev\\portfolio', home: 'C:\\Users\\me' };
  // FOX3 の deny と同じ形のルールを ask に置いたとき（2026-10-03 に実機で、どの Read も当たりになった）
  const rules = ['Read(~/.claude/channels/**)', 'Read(~/.ssh/**)', 'Read(.env)', 'Read(**/*.pem)', 'Edit(./Tool/FOX3-partner/**)'];

  it('範囲の外のパスには当たらない', () => {
    expect(matchingRule(req('Read', { file_path: 'C:\\dev\\claude-slack-channel\\package.json' }), rules, ctx)).toBeUndefined();
    expect(matchingRule(req('Edit', { file_path: 'C:\\dev\\portfolio\\src\\a.ts' }), rules, ctx)).toBeUndefined();
  });

  it('フォルダー以下（ホーム基準・作業フォルダー基準）のパスには当たる', () => {
    expect(matchingRule(req('Read', { file_path: 'C:\\Users\\me\\.ssh\\id_ed25519' }), rules, ctx)).toBe('Read(~/.ssh/**)');
    expect(matchingRule(req('Write', { file_path: 'C:\\dev\\portfolio\\Tool\\FOX3-partner\\x.json' }), rules, ctx)).toBe(
      'Edit(./Tool/FOX3-partner/**)'
    );
  });

  it('ファイル名だけのルールは、どのフォルダーでも名前が一致すれば当たる', () => {
    expect(matchingRule(req('Read', { file_path: 'C:\\dev\\x\\.env' }), rules, ctx)).toBe('Read(.env)');
    expect(matchingRule(req('Read', { file_path: 'C:\\dev\\x\\server.PEM' }), rules, ctx)).toBe('Read(**/*.pem)');
    expect(matchingRule(req('Read', { file_path: 'C:\\dev\\x\\env.txt' }), rules, ctx)).toBeUndefined();
  });

  it('パスが読めないか、複雑なパターンなら当たりにする（安全側）', () => {
    expect(matchingRule(req('Read', '{"file_path":"C:\\\\de…'), rules, ctx)).toBe('Read(~/.claude/channels/**)');
    expect(matchingRule(req('Read', { file_path: 'C:\\dev\\a\\b.ts' }), ['Read(src/**/secret/*)'], ctx)).toBe('Read(src/**/secret/*)');
  });
});

describe('SessionAllowAll', () => {
  it('有効にするまでは自動許可しない。有効なら ask に当たらないものだけ許可する', () => {
    const s = new SessionAllowAll(() => ['Bash(git push:*)']);
    expect(s.check(req('Bash', { command: 'ls' }))).toEqual({ allow: false });

    s.enable('U1', new Date(0));
    expect(s.current).toEqual({ since: new Date(0), byUserId: 'U1' });
    expect(s.check(req('Bash', { command: 'ls' }))).toEqual({ allow: true });
    expect(s.check(req('Bash', { command: 'git push' }))).toEqual({ allow: false, rule: 'Bash(git push:*)' });
  });

  it('二度目の enable では開始時刻を変えない。disable は有効だったかを返す', () => {
    const s = new SessionAllowAll(() => []);
    s.enable('U1', new Date(0));
    s.enable('U2', new Date(1000));
    expect(s.current?.byUserId).toBe('U1');
    expect(s.disable()).toBe(true);
    expect(s.disable()).toBe(false);
    expect(s.current).toBeUndefined();
  });

  it('ルールを読めなければ自動許可しない', () => {
    const s = new SessionAllowAll(() => {
      throw new Error('broken json');
    });
    s.enable('U1');
    expect(s.check(req('Bash', { command: 'ls' })).allow).toBe(false);
  });
});
