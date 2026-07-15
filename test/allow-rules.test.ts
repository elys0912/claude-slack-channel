import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AllowRuleStore, denyOverlaps, deriveRule, parseRuleForCheck, proposeRule, readDeny, toRulePath } from '../src/allow-rules.js';
import type { PermissionRequest } from '../src/permission.js';

function req(tool: string, input: unknown): PermissionRequest {
  return {
    request_id: 'abcde',
    tool_name: tool,
    description: '',
    input_preview: typeof input === 'string' ? input : JSON.stringify(input),
  };
}

describe('deriveRule', () => {
  it.each([
    ['Bash', 'git status --short', 'Bash(git status:*)'],
    ['PowerShell', 'Get-ChildItem -Force', 'PowerShell(Get-ChildItem:*)'],
    ['Bash', 'ls -la', 'Bash(ls:*)'],
    ['PowerShell', 'npm view react version', 'PowerShell(npm view:*)'],
  ])('%s の "%s" から %s を作る', (tool, command, rule) => {
    expect(deriveRule(req(tool, { command }))).toMatchObject({ ok: true, rule });
  });

  it('シェル以外はツール名だけのルールにする', () => {
    expect(deriveRule(req('WebFetch', { url: 'https://example.com' }))).toMatchObject({ ok: true, rule: 'WebFetch' });
  });

  it.each([
    ['rm -rf dist', '危険なコマンド'],
    ['Remove-Item foo', '読み取り系でない'],
    ['git push origin main', '危険な操作'],
    ['npm install left-pad', '危険な操作'],
    ['node script.js', '危険なコマンド'],
    ['claude -p "do it" --dangerously-skip-permissions', '危険なコマンド'],
    ['codex exec fix', '危険なコマンド'],
    ['uvx some-tool', '危険なコマンド'],
    ['npm test', '危険な操作'],
    ['dotnet run', '危険な操作'],
    ['curl https://example.com', '危険なコマンド'],
    ['git status && rm -rf /', '複数のコマンド'],
    ['echo hi > out.txt', 'リダイレクト'],
    ['Get-Content x | Out-File y', '複数のコマンド'],
    ['git', 'サブコマンドが取れない'],
    ['C:\\tools\\evil.exe', 'コマンド名が想定外'],
  ])('"%s" からは作らない（%s）', (command, reason) => {
    const result = deriveRule(req('Bash', { command }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it('ファイル編集のツールでも、相対パスからは作らない', () => {
    expect(deriveRule(req('Write', { file_path: 'a.txt' })).ok).toBe(false);
  });

  it('入力が JSON でない（省略されている）ときは作らない', () => {
    expect(deriveRule(req('Bash', '{"command":"git sta…')).ok).toBe(false);
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

  it('シェル以外でツール全体を許すルールは、中身のある deny と重なる', () => {
    expect(denyOverlaps({ tool: 'Read', prefix: undefined }, deny)).toEqual(['Read(.env)']);
  });

  it('関係ないものは重ならない', () => {
    expect(denyOverlaps({ tool: 'Bash', prefix: 'git status' }, deny)).toEqual([]);
    expect(denyOverlaps({ tool: 'PowerShell', prefix: 'git status' }, deny)).toEqual([]);
  });

  it('deny に当たったら理由と当たった deny を返す', () => {
    const result = proposeRule(req('Bash', { command: 'ls -la' }), deny);
    expect(result).toMatchObject({ ok: false, denyHits: ['Bash(ls:*)'] });
    if (!result.ok) expect(result.reason).toContain('deny に当たる');
  });

  it('当たらなければ候補を返す', () => {
    expect(proposeRule(req('Bash', { command: 'git status' }), deny)).toMatchObject({ ok: true, rule: 'Bash(git status:*)' });
  });
});

describe('readDeny / AllowRuleStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allow-rules-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('settings の permissions.deny を読む（無ければ空、壊れていれば投げる）', () => {
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ permissions: { deny: ['Read(.env)', 1] } }));
    expect(readDeny(file)).toEqual(['Read(.env)']);
    expect(readDeny(path.join(dir, 'none.json'))).toEqual([]);
    fs.writeFileSync(file, '{ broken');
    expect(() => readDeny(file)).toThrow('JSON 構文が不正');
  });

  it('壊れた allow-extra.json は一覧では空扱いにし、追加・削除は投げて上書きしない', () => {
    const file = path.join(dir, 'allow-extra.json');
    fs.writeFileSync(file, '{ broken');
    const store = new AllowRuleStore(file);
    expect(store.list()).toEqual([]);
    expect(() => store.add('WebFetch')).toThrow('JSON 構文が不正');
    expect(() => store.remove('WebFetch')).toThrow('JSON 構文が不正');
    expect(fs.readFileSync(file, 'utf8')).toBe('{ broken');
  });

  it('追加・重複・削除', () => {
    const store = new AllowRuleStore(path.join(dir, 'sub', 'allow-extra.json'));
    expect(store.list()).toEqual([]);
    expect(store.add('Bash(git status:*)')).toBe(true);
    expect(store.add('Bash(git status:*)')).toBe(false);
    expect(store.add('WebFetch')).toBe(true);
    expect(store.list()).toEqual(['Bash(git status:*)', 'WebFetch']);
    expect(store.remove('Bash(git status:*)')).toBe(true);
    expect(store.remove('Bash(git status:*)')).toBe(false);
    expect(store.list()).toEqual(['WebFetch']);
  });
});

const HOME = 'C:\\Users\\me';
const CTX = { workDir: 'C:\\dev\\foo', home: HOME };

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
    ['Read', { file_path: 'C:\\dev\\a.ts' }, '浅すぎる'],
    ['Read', { file_path: 'C:\\a.ts' }, '浅すぎる'],
    ['Read', { file_path: 'C:\\Users\\me\\a.txt' }, 'ホームフォルダー'],
    ['Grep', { pattern: 'x', path: 'C:\\Users' }, '浅すぎる'],
    ['Read', { file_path: 'C:\\dev\\[x]\\a.ts' }, '特殊な文字'],
    ['Read', { file_path: 'C:\\dev\\foo\\..\\..\\a.ts' }, '..'],
  ])('%s %j からは作らない（%s）', (tool, input, reason) => {
    const result = deriveRule(req(tool, input), HOME);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it('入力が JSON でない（省略されている）ときは作らない', () => {
    expect(deriveRule(req('Read', '{"file_path":"C:\\\\dev\\\\fo…'), HOME).ok).toBe(false);
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
