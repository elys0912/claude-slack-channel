// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildRejectedRulesText,
  denyOverlaps,
  deriveRule,
  isCompoundCommand,
  isDerivableRule,
  isReadOnlyMcpTool,
  normalizeCommandName,
  parseRuleForCheck,
  partitionStoredRules,
  proposeRule,
  toRulePath,
} from '../src/allow-rules.js';
import { AllowRuleStore } from '../src/allow-rule-store.js';
import { managedSettingsFiles, readDeny } from '../src/settings-files.js';
import { HOME, req } from './helpers/permission-request.js';
import { useTempDir } from './helpers/temp-dir.js';

const CTX = { workDir: 'C:\\dev\\foo', home: HOME };

describe('normalizeCommandName', () => {
  it.each([
    ['git', 'git'],
    ['GIT.EXE', 'git'],
    ['npm.cmd', 'npm'],
    ['run.bat', 'run'],
    ['more.com', 'more'],
    ['Get-ChildItem.ps1', 'get-childitem'],
    ['python3', 'python'],
    ['python3.12', 'python'],
    ['Python3.12.exe', 'python'],
    ['pip3', 'pip'],
    ['rm', 'remove-item'],
    ['DEL', 'remove-item'],
    ['Erase', 'remove-item'],
    ['rd', 'remove-item'],
    ['rmdir', 'remove-item'],
    ['ri', 'remove-item'],
    ['mv', 'move-item'],
    ['move', 'move-item'],
    ['mi', 'move-item'],
    ['cp', 'copy-item'],
    ['copy', 'copy-item'],
    ['cpi', 'copy-item'],
    ['sc', 'set-content'],
    ['ac', 'add-content'],
    ['ni', 'new-item'],
    ['ii', 'invoke-item'],
    ['icm', 'invoke-command'],
    ['rm.exe', 'remove-item'],
    ['Remove-Item', 'remove-item'],
  ])('%s → %s', (word, name) => {
    expect(normalizeCommandName(word)).toBe(name);
  });
});

describe('isCompoundCommand', () => {
  it('ask の照合と同じ区切り（途中の & を含む）と、リダイレクトを複合とみなす', () => {
    for (const command of ['a && b', 'a || b', 'a; b', 'a | b', 'a & b', 'a\nb', 'a $(b)', 'a `b`', 'a > b', 'a < b']) {
      expect(isCompoundCommand(command)).toBe(true);
    }
    expect(isCompoundCommand('git status')).toBe(false);
  });
});

describe('toRulePath', () => {
  it.each([
    ['C:\\dev\\foo', '//c/dev/foo'],
    ['D:/Work/x/', '//d/Work/x'],
    ['C:\\', '//c'],
    ['/home/a/proj', '//home/a/proj'],
  ])('%s → %s', (input, expected) => {
    expect(toRulePath(input)).toBe(expected);
  });

  it('相対パスや UNC は undefined', () => {
    expect(toRulePath('dev\\foo')).toBeUndefined();
    expect(toRulePath('//server/share')).toBeUndefined();
  });
});

describe('deriveRule（シェル）', () => {
  it.each([
    ['Bash', 'git status', 'Bash(git status)'],
    ['Bash', 'pwd', 'Bash(pwd)'],
    ['Bash', 'ls', 'Bash(ls)'],
    ['PowerShell', 'dir', 'PowerShell(dir)'],
    ['PowerShell', 'Get-Location', 'PowerShell(Get-Location)'],
    // 大文字小文字だけ違うものは、一覧の綴りでルールにする
    ['PowerShell', 'get-location', 'PowerShell(Get-Location)'],
    ['Bash', 'GIT Status', 'Bash(git status)'],
    // 前後と間の空白は詰める
    ['Bash', '  git   status  ', 'Bash(git status)'],
  ])('%s の "%s" から完全一致の %s を作る（:* を付けない）', (tool, command, rule) => {
    expect(deriveRule(req(tool, { command }))).toMatchObject({ ok: true, rule });
  });

  it.each([
    // 引数付きの呼び出し（D-SD-01。引数で書く・消す・環境変数を出すもの）
    'git status --short',
    'git log --oneline',
    'git log --output=x',
    'git log -p --all',
    'git branch',
    'git branch -D main',
    'git branch --edit-description',
    'ls -la',
    'ls C:\\x',
    'dir \\\\host\\share',
    'Get-ChildItem',
    'Get-ChildItem Env:',
    'Get-Location -Stack',
    'pwd -P',
    // 許可リストに無いもの（中身を読む・書く・コードを実行する・ネットワーク）
    'cat README.md',
    'type README.md',
    'Get-Content README.md',
    'head -n 5 a.txt',
    'find . -name x',
    'env FOO=1 ls',
    'rm -rf dist',
    'Remove-Item foo',
    'node script.js',
    'curl https://example.com',
    'git diff --no-index /dev/null x',
    'git show HEAD:x',
    'git push origin main',
    'git -C .. status',
    'git',
    // 綴りが一覧と違うもの（拡張子・版番号・別名。D-SC-01）
    'git.exe status',
    'git2 status',
    'GIT.CMD status',
    'ls.exe',
    'ls.cmd',
    'ls1',
    'dir2',
    'dir.bat',
    'pwd.ps1',
    'npm.cmd test',
    'python3.12 a.py',
    // 引用符・パス付きの先頭の語
    '"ls"',
    "'pwd'",
    './ls',
    'C:\\tools\\ls.exe',
  ])('"%s" からは作らない（許可リストのコマンドを引数なしで呼んだものではない）', (command) => {
    expect(deriveRule(req('Bash', { command }))).toMatchObject({ ok: false, reason: expect.stringContaining('許可リストのコマンドを引数なしで呼んだものではない') });
  });

  it.each([
    'git status && rm -rf /',
    'git status; rm x',
    'git status || x',
    'git status & rm x',
    'ls | xargs rm',
    'ls\nrm x',
    'ls $(rm x)',
    'ls `rm x`',
    'pwd > out.txt',
    'ls 2>&1',
    'Get-Location < in.txt',
  ])('"%s" からは作らない（複数のコマンド・リダイレクト）', (command) => {
    expect(deriveRule(req('Bash', { command }))).toMatchObject({ ok: false, reason: expect.stringContaining('複数のコマンドをつないだ・リダイレクトを含む') });
  });

  it('入力が JSON でない（省略されている）ときは作らない', () => {
    expect(deriveRule(req('Bash', '{"command":"git sta…')).ok).toBe(false);
  });
});

describe('deriveRule（パスを取るツール）', () => {
  it.each([
    ['Read', { file_path: 'C:\\dev\\foo\\src\\a.ts' }, 'Read(//c/dev/foo/src/**)'],
    ['Read', { file_path: '/home/u/proj/a.ts' }, 'Read(//home/u/proj/**)'],
    ['Grep', { pattern: 'x', path: 'C:\\dev\\foo' }, 'Read(//c/dev/foo/**)'],
    ['Glob', { pattern: '**/*.ts', path: 'C:\\dev\\foo\\src' }, 'Read(//c/dev/foo/src/**)'],
    ['Edit', { file_path: 'C:\\dev\\foo\\a.ts' }, 'Edit(//c/dev/foo/**)'],
    ['Write', { file_path: 'C:\\dev\\foo\\a.ts', content: '' }, 'Edit(//c/dev/foo/**)'],
    ['NotebookEdit', { notebook_path: 'C:\\dev\\foo\\n.ipynb' }, 'Edit(//c/dev/foo/**)'],
  ])('%s %j から %s を作る', (tool, input, rule) => {
    expect(deriveRule(req(tool, input), HOME)).toMatchObject({ ok: true, rule });
  });

  it.each([
    ['Grep', { pattern: 'x' }, 'パスを読み取れなかった'],
    ['Read', { file_path: 'a.ts' }, '絶対パスでない'],
    ['Write', { file_path: 'a.txt' }, '絶対パスでない'],
    ['Read', { file_path: 'C:\\dev\\a.ts' }, '浅すぎる'],
    ['Read', { file_path: 'C:\\a.ts' }, '浅すぎる'],
    ['Read', { file_path: 'C:\\Users\\me\\a.txt' }, 'ホームフォルダー'],
    ['Grep', { pattern: 'x', path: 'C:\\Users' }, '浅すぎる'],
    ['Read', { file_path: 'C:\\dev\\[x]\\a.ts' }, '特殊な文字'],
    ['Read', { file_path: 'C:\\dev\\foo\\..\\..\\a.ts' }, '..'],
  ])('%s %j からは作らない（%s）', (tool, input, reason) => {
    expect(deriveRule(req(tool, input), HOME)).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
  });

  it('入力が JSON でない（省略されている）ときは作らない', () => {
    expect(deriveRule(req('Read', '{"file_path":"C:\\\\dev\\\\fo…'), HOME).ok).toBe(false);
  });
});

describe('deriveRule（WebFetch）', () => {
  it('URL のホストに絞る（小文字にする）', () => {
    expect(deriveRule(req('WebFetch', { url: 'https://Docs.Example.com/a?b=c' }))).toMatchObject({
      ok: true,
      rule: 'WebFetch(domain:docs.example.com)',
    });
  });

  it.each([
    [{ prompt: 'x' }, 'URL を読み取れなかった'],
    [{ url: 'not a url' }, 'URL を読み取れなかった'],
    [{ url: 'file:///c:/secret.txt' }, 'ホストが想定外'],
    // ワイルドカード・IPv6 は domain: に入れない（D-DC-01）
    [{ url: 'https://*.example.com/' }, 'ホストが想定外'],
    [{ url: 'http://[::1]/' }, 'ホストが想定外'],
  ])('WebFetch %j からは作らない（%s）', (input, reason) => {
    expect(deriveRule(req('WebFetch', input))).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
  });
});

describe('deriveRule（MCP とそれ以外のツール）', () => {
  it.each([
    'mcp__github__get_issue',
    'mcp__github__list_pull_requests',
    'mcp__docs__searchDocs',
    'mcp__jira__listIssues',
    'mcp__jira__GetIssue',
    // ツール名の頭のサーバー名は外して見る
    'mcp__excel__excel_read_sheet',
  ])('名前から読み取り専用と分かる MCP のツール（%s）は、ツール名だけのルールにする', (tool) => {
    expect(deriveRule(req(tool, {}))).toMatchObject({ ok: true, rule: tool });
  });

  it.each([
    'WebSearch',
    'Task',
    'Agent',
    'mcp__github',
    'mcp__github__create_issue',
    'mcp__excel__excel_write_to_sheet',
    'mcp__shell__run_command',
    'mcp__x__getaway',
    'mcp__slackbridge__download_file',
    // 読み取りの動詞で始まっても、書き込みの語を含むもの（D-SC-02）
    'mcp__gh__get_or_create_x',
    'mcp__github__get_or_create_label',
    'mcp__gh__getAndDelete',
    'mcp__gh__list_and_delete',
    'mcp__gh__view_and_approve',
    'mcp__gh__find_replace',
  ])('それ以外のツール（%s）からは作らない', (tool) => {
    expect(deriveRule(req(tool, {}))).toMatchObject({ ok: false, reason: expect.stringContaining('読み取り専用と分かる MCP') });
  });

  it('isReadOnlyMcpTool は MCP の個別のツール名だけを見る', () => {
    expect(isReadOnlyMcpTool('mcp__github__get_issue')).toBe(true);
    expect(isReadOnlyMcpTool('get_issue')).toBe(false);
    expect(isReadOnlyMcpTool('mcp__github__get_issue(x)')).toBe(false);
  });
});

describe('isDerivableRule / partitionStoredRules / buildRejectedRulesText（D-SD-03）', () => {
  it.each([
    'Bash(git status)',
    'PowerShell(Get-Location)',
    'Bash(ls)',
    'Read(//c/dev/foo/**)',
    'Edit(//c/dev/foo/src/**)',
    'Read(//home/u/proj/**)',
    'WebFetch(domain:example.com)',
    'mcp__github__get_issue',
  ])('今の方式で作れる %s は使う', (rule) => {
    expect(isDerivableRule(rule, HOME)).toBe(true);
  });

  it.each([
    // 前の方式のシェルのルール（引数を問わない・許可リストの外）
    'Bash(git status:*)',
    'Bash(git log:*)',
    'Bash(git branch:*)',
    'PowerShell(Get-ChildItem:*)',
    'PowerShell(npm.cmd:*)',
    'Bash(find:*)',
    'Bash(cat:*)',
    'Bash(git.exe status:*)',
    'Bash(ls -la)',
    'Bash',
    'PowerShell',
    // ツール全体・広すぎる・形が違うもの
    'WebFetch',
    'WebFetch(domain:*.example.com)',
    'WebFetch(domain:[::1])',
    'WebFetch(https://example.com)',
    'Read',
    'Read(./**)',
    'Read(//c/dev/**)',
    'Read(//c/users/me/**)',
    'Read(//c/users/**)',
    'Read(//c/dev/foo/*)',
    'Read(//c/dev//foo/**)',
    'Read(//c/dev/foo/../**)',
    'Edit(//c/dev/[x]/**)',
    'mcp__github',
    'mcp__github__create_issue',
    'mcp__gh__get_or_create_x',
    'WebSearch',
    'not a rule(',
    ' Bash(ls)',
  ])('今の方式で作れない %s は使わない', (rule) => {
    expect(isDerivableRule(rule, HOME)).toBe(false);
  });

  it('保存済みのルールを、順番を保って使うものと使わないものに分ける', () => {
    expect(partitionStoredRules(['Bash(git status)', 'Bash(git log:*)', 'Read(//c/dev/foo/**)', 'WebFetch'], HOME)).toEqual({
      usable: ['Bash(git status)', 'Read(//c/dev/foo/**)'],
      rejected: ['Bash(git log:*)', 'WebFetch'],
    });
  });

  it('作れないルールが無ければ、知らせは undefined', () => {
    expect(buildRejectedRulesText([])).toBeUndefined();
  });

  it('作れないルールの知らせには、件数と一覧と !rules の案内を書く', () => {
    const text = buildRejectedRulesText(['Bash(git log:*)', 'WebFetch']) ?? '';
    expect(text).toContain('2 件');
    expect(text).toContain('• Bash(git log:*)');
    expect(text).toContain('• WebFetch');
    expect(text).toContain('!rules');
  });

  it('作れないルールが 20 件を超えたら、一覧は 20 件までにして残りは件数だけ書く', () => {
    const many = buildRejectedRulesText(Array.from({ length: 25 }, (_, i) => `Bash(x${i}:*)`)) ?? '';
    expect(many).toContain('25 件');
    expect(many).toContain('• Bash(x19:*)');
    expect(many).not.toContain('• Bash(x20:*)');
    expect(many).toContain('ほか 5 件');
  });

  it('deriveRule が作るルールは、どれも isDerivableRule が使うと判定する', () => {
    const made = [
      deriveRule(req('Bash', { command: 'git status' }), HOME),
      deriveRule(req('PowerShell', { command: 'dir' }), HOME),
      deriveRule(req('Read', { file_path: 'C:\\dev\\foo\\a.ts' }), HOME),
      deriveRule(req('Write', { file_path: '/home/u/proj/a.ts' }), HOME),
      deriveRule(req('WebFetch', { url: 'https://example.com/x' }), HOME),
      deriveRule(req('mcp__github__get_issue', {}), HOME),
    ];
    for (const result of made) {
      expect(result.ok).toBe(true);
      if (result.ok) expect(isDerivableRule(result.rule, HOME)).toBe(true);
    }
  });
});

describe('denyOverlaps / proposeRule', () => {
  const deny = ['Bash(git push --force:*)', 'Read(.env)', 'PowerShell(git reset --hard:*)', 'Bash(ls:*)'];

  it('deny が候補より狭くても重なるとみなす', () => {
    expect(denyOverlaps({ tool: 'Bash', prefix: 'git push' }, deny)).toEqual(['Bash(git push --force:*)']);
  });

  it('deny が候補と同じか広ければ重なる', () => {
    expect(denyOverlaps({ tool: 'Bash', prefix: 'ls' }, deny)).toEqual(['Bash(ls:*)']);
  });

  it('シェルの PowerShell の別名は、本来のコマンドレットと同じく deny と重なる', () => {
    const psDeny = ['PowerShell(Get-ChildItem:*)', 'PowerShell(rm:*)'];
    expect(denyOverlaps({ tool: 'PowerShell', prefix: 'ls' }, psDeny)).toEqual(['PowerShell(Get-ChildItem:*)']);
    expect(denyOverlaps({ tool: 'PowerShell', prefix: 'dir' }, psDeny)).toEqual(['PowerShell(Get-ChildItem:*)']);
    expect(denyOverlaps({ tool: 'PowerShell', prefix: 'Remove-Item' }, psDeny)).toEqual(['PowerShell(rm:*)']);
    expect(denyOverlaps({ tool: 'PowerShell', prefix: 'del' }, psDeny)).toEqual(['PowerShell(rm:*)']);
  });

  it('ツール名の大文字小文字が違っても、シェルの別名は正規化して deny と重なる', () => {
    const psDeny = ['powershell(Get-ChildItem:*)'];
    expect(denyOverlaps({ tool: 'PowerShell', prefix: 'ls' }, psDeny)).toEqual(psDeny);
    expect(denyOverlaps({ tool: 'powershell', prefix: 'ls' }, psDeny)).toEqual(psDeny);
    expect(denyOverlaps({ tool: 'BASH', prefix: 'del' }, ['bash(rm:*)'])).toEqual(['bash(rm:*)']);
    expect(denyOverlaps(parseRuleForCheck('powershell(dir)') ?? { tool: '', prefix: undefined }, psDeny)).toEqual(psDeny);
  });

  it('正規化で綴りが変わっても、そのままの綴りで重なるものは重なる', () => {
    expect(denyOverlaps({ tool: 'Bash', prefix: 'ls' }, ['Bash(l:*)'])).toEqual(['Bash(l:*)']);
  });

  it('シェル以外でツール全体を許すルールは、中身のある deny と重なる', () => {
    expect(denyOverlaps({ tool: 'Read', prefix: undefined }, deny)).toEqual(['Read(.env)']);
  });

  it('関係ないものは重ならない', () => {
    expect(denyOverlaps({ tool: 'Bash', prefix: 'git status' }, deny)).toEqual([]);
    expect(denyOverlaps({ tool: 'PowerShell', prefix: 'git status' }, deny)).toEqual([]);
  });

  it('deny に当たったら理由と当たった deny を返す', () => {
    const result = proposeRule(req('Bash', { command: 'ls' }), deny);
    expect(result).toMatchObject({ ok: false, denyHits: ['Bash(ls:*)'] });
    if (!result.ok) expect(result.reason).toContain('deny に当たる');
  });

  it('当たらなければ候補を返す', () => {
    expect(proposeRule(req('Bash', { command: 'git status' }), deny)).toMatchObject({ ok: true, rule: 'Bash(git status)' });
  });

  it('保存済みのシェルのルールを parseRuleForCheck で戻しても同じ照合になる', () => {
    expect(parseRuleForCheck('Bash(git status)')).toEqual({ tool: 'Bash', prefix: 'git status' });
    expect(denyOverlaps(parseRuleForCheck('Bash(ls)') ?? { tool: '', prefix: undefined }, deny)).toEqual(['Bash(ls:*)']);
  });
});

describe('denyOverlaps（パスのルール）', () => {
  const candidate = { tool: 'Read', prefix: '//c/dev/foo/**' };

  it('一部だけ重なる deny（ファイル名・別の場所）には当たらない', () => {
    expect(denyOverlaps(candidate, ['Read(.env)', 'Read(**/.env)', 'Read(~/.ssh/*)', 'Read(//c/dev/foo/secrets/**)', 'Read(*.key)'], CTX)).toEqual([]);
  });

  it('ツール全体の deny、または同じか親のフォルダー以下全部の deny には当たる', () => {
    expect(denyOverlaps(candidate, ['Read'], CTX)).toEqual(['Read']);
    expect(denyOverlaps(candidate, ['Read(//c/dev/**)'], CTX)).toEqual(['Read(//c/dev/**)']);
    expect(denyOverlaps(candidate, ['Read(//C/Dev/Foo/**)'], CTX)).toEqual(['Read(//C/Dev/Foo/**)']);
    expect(denyOverlaps(candidate, ['Read(//c/dev/foo)'], CTX)).toEqual(['Read(//c/dev/foo)']);
  });

  it('作業フォルダー基準・ホーム基準の deny も解決して照合する', () => {
    const secrets = { tool: 'Read', prefix: '//c/dev/foo/secrets/x/**' };
    expect(denyOverlaps(secrets, ['Read(./secrets/**)'], CTX)).toEqual(['Read(./secrets/**)']);
    expect(denyOverlaps(secrets, ['Read(/secrets/**)'], CTX)).toEqual(['Read(/secrets/**)']);
    const ssh = { tool: 'Read', prefix: '//c/users/me/.ssh/keys/**' };
    expect(denyOverlaps(ssh, ['Read(~/.ssh/**)'], CTX)).toEqual(['Read(~/.ssh/**)']);
  });

  it('ツールが違う deny には当たらない', () => {
    expect(denyOverlaps(candidate, ['Edit(//c/dev/**)', 'Edit'], CTX)).toEqual([]);
  });

  it('保存済みのルールを parseRuleForCheck で戻しても同じ照合になる（confirm の再照合）', () => {
    const parsed = parseRuleForCheck('Read(//c/dev/foo/**)');
    expect(parsed).toEqual(candidate);
    expect(denyOverlaps(parsed ?? candidate, ['Read(.env)', 'Read(//c/dev/**)'], CTX)).toEqual(['Read(//c/dev/**)']);
  });

  it('proposeRule: .env などの deny があっても、フォルダー以下の Read を提案できる', () => {
    const result = proposeRule(req('Read', { file_path: 'C:\\dev\\foo\\a.ts' }), ['Read(.env)', 'Read(~/.ssh/*)', 'Read(~/.aws/**)'], CTX);
    expect(result).toMatchObject({ ok: true, rule: 'Read(//c/dev/foo/**)' });
  });

  it('proposeRule: 親フォルダーが丸ごと deny なら断る', () => {
    const result = proposeRule(req('Write', { file_path: 'C:\\dev\\foo\\a.ts' }), ['Edit(//c/dev/**)'], CTX);
    expect(result).toMatchObject({ ok: false, denyHits: ['Edit(//c/dev/**)'] });
  });
});

describe('readDeny / AllowRuleStore / managedSettingsFiles', () => {
  const tempDir = useTempDir('allow-rules-');
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  it('readDeny: settings の permissions.deny のうち文字列だけを読む（先頭の BOM は外す）', () => {
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ permissions: { deny: ['Read(.env)', 1] } }));
    expect(readDeny(file)).toEqual(['Read(.env)']);
  });

  it('readDeny: ファイルが無ければ空', () => {
    expect(readDeny(path.join(dir, 'none.json'))).toEqual([]);
  });

  it('readDeny: JSON として壊れていれば投げる', () => {
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, '{ broken');
    expect(() => readDeny(file)).toThrow('JSON 構文が不正');
  });

  it('managedSettingsFiles: managed-settings.json と managed-settings.d の *.json を名前順に返す', () => {
    const dropIn = path.join(dir, 'managed-settings.d');
    fs.mkdirSync(dropIn);
    for (const name of ['20-b.json', '10-a.json', '.hidden.json', 'note.txt']) fs.writeFileSync(path.join(dropIn, name), '{}');
    expect(managedSettingsFiles([dir])).toEqual([
      path.join(dir, 'managed-settings.json'),
      path.join(dropIn, '10-a.json'),
      path.join(dropIn, '20-b.json'),
    ]);
  });

  it('managedSettingsFiles: managed-settings.d が無ければ managed-settings.json だけ', () => {
    expect(managedSettingsFiles([dir])).toEqual([path.join(dir, 'managed-settings.json')]);
  });

  it('managedSettingsFiles: managed-settings.d がフォルダーとして読めなければ投げる', () => {
    fs.writeFileSync(path.join(dir, 'managed-settings.d'), 'not a dir');
    expect(() => managedSettingsFiles([dir])).toThrow('を読めない');
  });

  it('managedSettingsFiles: 候補のフォルダー（今の置き場所と古い置き場所）を全部読む（D-DC-04）', () => {
    const current = path.join(dir, 'Program Files', 'ClaudeCode');
    const legacy = path.join(dir, 'ProgramData', 'ClaudeCode');
    fs.mkdirSync(path.join(legacy, 'managed-settings.d'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'managed-settings.d', 'a.json'), '{}');
    expect(managedSettingsFiles([current, legacy])).toEqual([
      path.join(current, 'managed-settings.json'),
      path.join(legacy, 'managed-settings.json'),
      path.join(legacy, 'managed-settings.d', 'a.json'),
    ]);
  });

  it.runIf(process.platform === 'win32')('managedSettingsFiles: Windows の既定は Program Files と ProgramData の両方', () => {
    const files = managedSettingsFiles();
    expect(files).toContain('C:\\Program Files\\ClaudeCode\\managed-settings.json');
    expect(files).toContain('C:\\ProgramData\\ClaudeCode\\managed-settings.json');
  });

  it('壊れた allow-extra.json は一覧では空扱いにし、読む・追加・削除は投げて上書きしない', () => {
    const file = path.join(dir, 'allow-extra.json');
    fs.writeFileSync(file, '{ broken');
    const store = new AllowRuleStore(file);
    expect(store.list()).toEqual([]);
    expect(() => store.read()).toThrow('JSON 構文が不正');
    expect(() => store.add('WebFetch')).toThrow('JSON 構文が不正');
    expect(() => store.remove('WebFetch')).toThrow('JSON 構文が不正');
    expect(fs.readFileSync(file, 'utf8')).toBe('{ broken');
  });

  it('AllowRuleStore: ファイルが無ければ一覧は空', () => {
    expect(new AllowRuleStore(path.join(dir, 'sub', 'allow-extra.json')).list()).toEqual([]);
  });

  it('AllowRuleStore: 追加したルールを足した順に並べ、同じルールの追加は false を返して増やさない', () => {
    const store = new AllowRuleStore(path.join(dir, 'sub', 'allow-extra.json'));
    expect(store.add('Bash(git status)')).toBe(true);
    expect(store.add('Bash(git status)')).toBe(false);
    expect(store.add('WebFetch')).toBe(true);
    expect(store.list()).toEqual(['Bash(git status)', 'WebFetch']);
  });

  it('AllowRuleStore: 削除はあったルールだけ true を返して消し、無いルールは false', () => {
    const store = new AllowRuleStore(path.join(dir, 'sub', 'allow-extra.json'));
    store.add('Bash(git status)');
    store.add('WebFetch');
    expect(store.remove('Bash(git status)')).toBe(true);
    expect(store.remove('Bash(git status)')).toBe(false);
    expect(store.list()).toEqual(['WebFetch']);
  });
});
