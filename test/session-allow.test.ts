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

describe('SessionAllowAll', () => {
  it('有効にするまでは自動許可しない。有効なら ask / deny に当たらないものだけ許可する', () => {
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
