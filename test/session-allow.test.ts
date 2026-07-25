// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
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

const PUSH = 'Bash(git push:*)';
const PS_PUSH = 'PowerShell(git push:*)';

describe('matchingRule', () => {
  it('ツール全体のルールは、そのツールの全リクエストに当たる', () => {
    expect(matchingRule(req('WebFetch', { url: 'https://example.com' }), ['WebFetch'])).toBe('WebFetch');
    expect(matchingRule(req('mcp__a__b', {}), ['mcp__a__b'])).toBe('mcp__a__b');
  });

  it('シェルの中身付きルールは、コマンドがプレフィックスで始まるときだけ当たる', () => {
    const rules = [PUSH, 'PowerShell(Remove-Item *)'];
    expect(matchingRule(req('Bash', { command: 'git push origin main' }), rules)).toBe(PUSH);
    expect(matchingRule(req('Bash', { command: 'git status' }), rules)).toBeUndefined();
    expect(matchingRule(req('PowerShell', { command: 'remove-item foo' }), rules)).toBe('PowerShell(Remove-Item *)');
  });

  it('シェルでコマンドが読めなければ、安全側に倒して当たりにする', () => {
    expect(matchingRule(req('Bash', '{"command":"git pu…'), [PUSH])).toBe(PUSH);
  });

  it('Read / Edit のルールは、それが効くツール全部に当たる（中身付きは安全側に倒して当たり）', () => {
    expect(matchingRule(req('Grep', { pattern: 'x' }), ['Read(./.env)'])).toBe('Read(./.env)');
    expect(matchingRule(req('Write', { file_path: 'C:\\a.txt' }), ['Edit(//c/**)'])).toBe('Edit(//c/**)');
    expect(matchingRule(req('Write', { file_path: 'C:\\a.txt' }), ['Read(//c/**)'])).toBeUndefined();
  });

  it('関係ないツールのルールには当たらない', () => {
    expect(matchingRule(req('Bash', { command: 'ls' }), ['WebFetch', 'Read(.env)', 'mcp__a'])).toBeUndefined();
  });

  it('形の読めないルールは、判断できないので当たりにする', () => {
    expect(matchingRule(req('Bash', { command: 'ls' }), ['not a rule('])).toBe('not a rule(');
  });

  it.each([
    'cd repo && git push origin main',
    'git status; git push',
    'git status || git push',
    'echo x | git push',
    'tee x | git push',
    'echo a & git push',
    'git status\ngit push',
    'git.exe push origin main',
    'GIT.CMD push',
  ])('複合コマンドは部分ごとに照合し、先頭の語は正規化する（%s）', (command) => {
    expect(matchingRule(req('Bash', { command }), [PUSH])).toBe(PUSH);
  });

  it.each([
    'FOO=1 ls',
    'env ls',
    'sudo ls',
    'runas /user:x ls',
    'cmd /c ls',
    'powershell -Command ls',
    'npx git push',
    'watch ls',
    './x.sh',
    '/usr/bin/git status',
    'C:\\tools\\x.exe ls',
  ])('先頭が環境変数の代入・ラッパー・パスの部分（%s）は当たりにする', (command) => {
    expect(matchingRule(req('Bash', { command }), [PUSH])).toBe(PUSH);
  });

  it.each([
    // 引用符・エスケープでサブコマンドが綴り直されたもの（D-SD-02 の 1）
    'git "push" origin',
    "git 'push'",
    'git p""ush',
    'git pus\\h',
    'git `push',
    '"git" status',
    'echo "a;b" ; git push',
    // 継続・区切りの誤分割（D-SD-02 の 2）
    'git `\npush',
    'git \\\npush',
    'git push`',
    // 予約語・ブロックが先頭の部分（D-SD-02 の 3）
    'if ($true) { git push }',
    'try { git push } catch {}',
    'foreach ($i in 1) { git push }',
    'if true; then git push; fi',
    'for i in 1; do git push; done',
    'while true; do git push; done',
    '(git status)',
    'echo $(git push)',
    // スクリプトブロックを取るコマンドレット（D-SD-02 の 4）
    'Get-Date | ForEach-Object { git push }',
    'Get-Date | % { git push }',
    'Start-Job { git push }',
    'Invoke-Expression "git push"',
    'iex "git push"',
  ])('引用符・バッククォート・かっこ・制御構文を含むもの（%s）は、解釈しないので当たりにする', (command) => {
    expect(matchingRule(req('Bash', { command }), [PUSH])).toBe(PUSH);
    expect(matchingRule(req('PowerShell', { command }), [PS_PUSH])).toBe(PS_PUSH);
  });

  it.each([
    'Get-Date | where Name -eq x',
    'Get-Date | WHERE Name -eq x',
    'Get-Date | ? Name -eq x',
    'Get-Date | Where-Object Name -eq x',
  ])('Where-Object とその別名（%s）を含むものは、解釈しないので当たりにする', (command) => {
    expect(matchingRule(req('PowerShell', { command }), [PS_PUSH])).toBe(PS_PUSH);
  });

  it.each(['start x', 'saps x', 'Start-Process x', 'iex x', 'Invoke-Expression x', 'icm x', 'Invoke-Command x', 'sajb x', 'Start-Job x'])(
    '先頭が PowerShell のラッパーか、その別名（%s）なら当たりにする',
    (command) => {
      expect(matchingRule(req('PowerShell', { command }), [PS_PUSH])).toBe(PS_PUSH);
    }
  );

  it.each(['git -C x push','git --no-pager push', 'git.exe -c a=b push', 'git $x origin', 'git pu* origin', 'git pu?h'])(
    'サブコマンドの位置がオプションか、展開で変わりうる語（%s）なら当たりにする',
    (command) => {
      expect(matchingRule(req('Bash', { command }), [PUSH])).toBe(PUSH);
    }
  );

  it.each(['find . -exec git push', 'echo git push', 'xargs git push', 'nohup git push'])(
    '部分の途中にプレフィックスの語が並ぶもの（%s）も当たりにする（確認が出るだけなので安全側）',
    (command) => {
      expect(matchingRule(req('Bash', { command }), [PUSH])).toBe(PUSH);
    }
  );

  it.each([
    ['rm -r foo', 'Remove-Item -r foo', 'PowerShell(Remove-Item:*)'],
    ['DEL foo', 'Remove-Item foo', 'PowerShell(Remove-Item:*)'],
    ['erase foo', 'Remove-Item foo', 'PowerShell(Remove-Item:*)'],
    ['rd foo', 'Remove-Item foo', 'PowerShell(Remove-Item:*)'],
    ['rmdir foo', 'Remove-Item foo', 'PowerShell(Remove-Item:*)'],
    ['ri foo', 'Remove-Item foo', 'PowerShell(Remove-Item:*)'],
    ['cd x; del foo', 'cd x; Remove-Item foo', 'PowerShell(Remove-Item:*)'],
    ['mv a b', 'Move-Item a b', 'PowerShell(Move-Item:*)'],
    ['move a b', 'Move-Item a b', 'PowerShell(Move-Item:*)'],
    ['mi a b', 'Move-Item a b', 'PowerShell(Move-Item:*)'],
    ['cp a b', 'Copy-Item a b', 'PowerShell(Copy-Item:*)'],
    ['copy a b', 'Copy-Item a b', 'PowerShell(Copy-Item:*)'],
    ['cpi a b', 'Copy-Item a b', 'PowerShell(Copy-Item:*)'],
    ['sc a x', 'Set-Content a x', 'PowerShell(Set-Content:*)'],
    ['ac a x', 'Add-Content a x', 'PowerShell(Add-Content:*)'],
    ['ni a', 'New-Item a', 'PowerShell(New-Item:*)'],
    ['ii a', 'Invoke-Item a', 'PowerShell(Invoke-Item:*)'],
    ['icm -ComputerName a', 'Invoke-Command -ComputerName a', 'PowerShell(Invoke-Command:*)'],
  ])('PowerShell の別名（%s）は、本来のコマンドレット（%s）と同じく ask に当たる', (aliased, canonical, rule) => {
    expect(matchingRule(req('PowerShell', { command: canonical }), [rule])).toBe(rule);
    expect(matchingRule(req('PowerShell', { command: aliased }), [rule])).toBe(rule);
  });

  it('ask のルールが別名で書かれていても、本来のコマンドレットのコマンドに当たる', () => {
    expect(matchingRule(req('PowerShell', { command: 'Remove-Item foo' }), ['PowerShell(rm:*)'])).toBe('PowerShell(rm:*)');
    expect(matchingRule(req('PowerShell', { command: 'del foo' }), ['PowerShell(rm:*)'])).toBe('PowerShell(rm:*)');
    expect(matchingRule(req('Bash', { command: 'rm -rf foo' }), ['Bash(rm -rf:*)'])).toBe('Bash(rm -rf:*)');
  });

  it('別名の正規化で、関係ないコマンドが当たるようにはならない', () => {
    expect(matchingRule(req('PowerShell', { command: 'Get-ChildItem foo' }), ['PowerShell(Remove-Item:*)'])).toBeUndefined();
    expect(matchingRule(req('PowerShell', { command: 'rename-item a b' }), ['PowerShell(Remove-Item:*)'])).toBeUndefined();
  });

  it('ワイルドカードを含むプレフィックスは当たりにする', () => {
    expect(matchingRule(req('Bash', { command: 'ls' }), ['Bash(git * --force)'])).toBe('Bash(git * --force)');
  });

  it('どの部分にもプレフィックスの語の並びが無ければ当たらない', () => {
    expect(matchingRule(req('Bash', { command: 'cd repo && git status | head -5' }), [PUSH])).toBeUndefined();
    expect(matchingRule(req('Bash', { command: 'git pull' }), [PUSH])).toBeUndefined();
    expect(matchingRule(req('PowerShell', { command: 'Get-ChildItem C:\\dev | Select-Object Name' }), [PS_PUSH])).toBeUndefined();
  });

  it('サーバー単位の MCP のルール（mcp__<サーバー> / mcp__<サーバー>__*）は、そのサーバーの全ツールに当たる', () => {
    expect(matchingRule(req('mcp__github__create_issue', {}), ['mcp__github'])).toBe('mcp__github');
    expect(matchingRule(req('mcp__github__create_issue', {}), ['mcp__github__*'])).toBe('mcp__github__*');
    expect(matchingRule(req('mcp__githubx__create_issue', {}), ['mcp__github'])).toBeUndefined();
    expect(matchingRule(req('mcp__github__get_issue', {}), ['mcp__github__get'])).toBeUndefined();
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
    const s = new SessionAllowAll(() => [PUSH]);
    expect(s.check(req('Bash', { command: 'ls' }))).toEqual({ allow: false });

    s.enable('U1', new Date(0));
    expect(s.current).toEqual({ since: new Date(0), byUserId: 'U1' });
    expect(s.check(req('Bash', { command: 'ls' }))).toEqual({ allow: true });
    expect(s.check(req('Bash', { command: 'git push' }))).toEqual({ allow: false, rule: PUSH });
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

  it('ルールを読めなければ自動許可しない。全部許可のボタンも出せない（available が false）', () => {
    const s = new SessionAllowAll(() => {
      throw new Error('broken json');
    });
    expect(s.available()).toBe(false);
    s.enable('U1');
    expect(s.check(req('Bash', { command: 'ls' })).allow).toBe(false);
  });

  it('ルールを読めれば available は true', () => {
    expect(new SessionAllowAll(() => []).available()).toBe(true);
  });
});
