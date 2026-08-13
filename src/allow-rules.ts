// チャットから許可リスト（allow）にルールを恒久追加するための、ルールの生成と安全確認（保存は allow-rule-store.ts、settings の読み込みは settings-files.ts）。
// ルールは実行許可のリクエストの中身からだけ作り、自由な入力は受け付けない。
// 作ってよいものを許可リストで決め（シェルは SHELL_RULE_ALLOWLIST）、それ以外・広すぎるもの・deny と重なるものは作らない
// （チャットのアカウントの乗っ取りや注入された指示で、何でも無確認実行されるのを防ぐ）。
// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
import os from 'node:os';
import path from 'node:path';
import { inputField } from './permission-core.js';
import type { PermissionRequest } from './permission-core.js';

// ルールの種別（シェル・パス・WebFetch・MCP）ごとの扱いは、このファイルと session-allow.ts（ask との照合）の複数の箇所に分かれている。
// 各箇所の説明に「ルールの種別の対応箇所」と書いた。種別を足す・変えるときは、この語で検索して併せて直す（SHELL_TOOLS もその 1 つ）。
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** 保存済みのルールのツール名を大文字小文字を区別せずにシェルと判定するための、SHELL_TOOLS の小文字 */
const SHELL_TOOLS_LOWER = new Set([...SHELL_TOOLS].map((tool) => tool.toLowerCase()));

/**
 * パスを取るツールのルールの作り方。
 * - field: 入力のうちパスの項目
 * - isDir: パスがフォルダーそのものか（Grep / Glob）。false ならファイルなので、その親フォルダーにする
 */
interface PathToolSpec {
  ruleTool: 'Read' | 'Edit';
  field: string;
  isDir: boolean;
}

/**
 * パスを取るツール。ツール全体ではなく、対象のフォルダー以下に絞ったルールにする。
 * Claude Code がパスで照合するのは Read(path) と Edit(path) だけなので、ルールはこの 2 つのどちらかで作る
 * （Edit のルールはファイルを書き換える組み込みツール全部に、Read のルールは Grep / Glob にも効く）。ルールの種別の対応箇所
 */
const PATH_TOOLS: ReadonlyMap<string, PathToolSpec> = new Map([
  ['Read', { ruleTool: 'Read', field: 'file_path', isDir: false }],
  ['Grep', { ruleTool: 'Read', field: 'path', isDir: true }],
  ['Glob', { ruleTool: 'Read', field: 'path', isDir: true }],
  ['Edit', { ruleTool: 'Edit', field: 'file_path', isDir: false }],
  ['Write', { ruleTool: 'Edit', field: 'file_path', isDir: false }],
  ['MultiEdit', { ruleTool: 'Edit', field: 'file_path', isDir: false }],
  ['NotebookEdit', { ruleTool: 'Edit', field: 'notebook_path', isDir: false }],
]);
/** パスで照合されるルールのツール。ルールの種別の対応箇所 */
const PATH_RULE_TOOLS = new Set(['read', 'edit']);
/** フォルダー以下全部を指すパスのルールの末尾 */
const PATH_RULE_SUFFIX = '/**';
/** Windows のドライブ名で始まるパス（`C:`） */
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;
/** フォルダーの深さ（ドライブ・ルートの下の段数）がこれ未満なら、広すぎるので作らない（例: //c/dev は 1 段） */
const MIN_DIR_DEPTH = 2;
/** gitignore のパターンで特別な意味を持つ文字。含むパスからは作らない（エスケープの取り違えで範囲が変わるのを避ける） */
const GLOB_CHARS_RE = /[*?[\]!#{}\\]/;
/**
 * 「♾ 今後も許可」でルールにできるシェルのコマンド（許可リスト）。引数を取らない呼び出しの完全一致だけで、
 * ルールは `Tool(<コマンド>)`（`:*` を付けない）にする。引数付きの呼び出し（`ls C:\x` など）からは作らない。
 * 引数を問わない形にすると、`git log --output=<ファイル>`（書き込み）・`git branch -D`（ref の削除）・
 * `Get-ChildItem Env:`（環境変数の中身）のように、引数で読み書きできてしまう。
 * 入力の綴りは大文字小文字を除いてこの一覧と同じときだけ当てはめ、ルールにはこの一覧の綴りを使う。
 * 一覧は docs/security.md にも書いてある（変えるときは両方を直す）
 */
export const SHELL_RULE_ALLOWLIST: readonly string[] = ['git status', 'pwd', 'Get-Location', 'ls', 'dir'];
/** 先頭の語の末尾から剥がす実行ファイルの拡張子 */
const EXECUTABLE_EXT_RE = /\.(?:exe|cmd|bat|com|ps1)$/;
/** 先頭の語の末尾から剥がす版番号（`python3.12` の `3.12`、`pip3` の `3`） */
const VERSION_SUFFIX_RE = /(?<=[a-z])\d+(?:\.\d+)*$/;
/**
 * PowerShell の組み込みの別名（小文字）と、その本来のコマンドレット（小文字）。照合の前に本来の名前に直す。
 * `rm x` が `PowerShell(Remove-Item:*)` の ask をすり抜けないようにするため。
 * 両方の側（ルールとコマンド）を同じ名前に直すので、当たる範囲は広がるだけで狭まらない（Bash の `rm` も Remove-Item とみなす）。
 * 削除・移動・書き込み・実行・プロセスの停止・通信・ファイルの読み取り・一覧に当たるものを並べる（Windows PowerShell 5.1 の別名）
 */
export const POWERSHELL_ALIASES: ReadonlyMap<string, string> = new Map([
  ['rm', 'remove-item'], ['del', 'remove-item'], ['erase', 'remove-item'], ['rd', 'remove-item'], ['rmdir', 'remove-item'], ['ri', 'remove-item'],
  ['mv', 'move-item'], ['move', 'move-item'], ['mi', 'move-item'],
  ['cp', 'copy-item'], ['copy', 'copy-item'], ['cpi', 'copy-item'],
  ['ren', 'rename-item'], ['rni', 'rename-item'],
  ['ni', 'new-item'],
  ['si', 'set-item'],
  ['cli', 'clear-item'],
  ['sc', 'set-content'],
  ['ac', 'add-content'],
  ['clc', 'clear-content'],
  ['sp', 'set-itemproperty'],
  ['rp', 'remove-itemproperty'],
  ['tee', 'tee-object'],
  ['cat', 'get-content'], ['gc', 'get-content'], ['type', 'get-content'],
  ['ls', 'get-childitem'], ['dir', 'get-childitem'], ['gci', 'get-childitem'],
  ['ii', 'invoke-item'],
  ['iex', 'invoke-expression'],
  ['icm', 'invoke-command'],
  ['start', 'start-process'], ['saps', 'start-process'],
  ['sajb', 'start-job'],
  ['kill', 'stop-process'], ['spps', 'stop-process'],
  ['iwr', 'invoke-webrequest'], ['curl', 'invoke-webrequest'], ['wget', 'invoke-webrequest'],
  ['irm', 'invoke-restmethod'],
]);
/**
 * ツール全体を許すルールにしてよい MCP のツールの、名前の最初の語（読み取り専用と名前から分かるもの）。
 * MCP の個別のツール（`mcp__<サーバー>__<ツール>`）だけが対象で、名前に MCP_WRITE_WORDS を含むものは除く
 */
export const READ_ONLY_MCP_VERBS: ReadonlySet<string> = new Set(['get', 'list', 'read', 'search', 'find', 'describe', 'view', 'show']);
/**
 * 読み取りの動詞で始まっても、含んでいれば読み取り専用とみなさない語。
 * `or` と `and` は、`get_or_create` のように読み取りの動詞で始まって書き込みも兼ねる名前を、読み取り専用と取り違えないため
 */
const MCP_WRITE_WORDS = new Set([
  'create', 'update', 'delete', 'remove', 'write', 'set', 'add', 'put', 'post', 'send', 'edit', 'modify', 'move',
  'rename', 'upload', 'download', 'install', 'run', 'exec', 'execute', 'push', 'merge', 'close', 'approve', 'replace',
  'or', 'and',
]);
/** MCP の個別のツール名。1 つ目がサーバー名、2 つ目がツール名 */
const MCP_TOOL_RE = /^mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__([A-Za-z0-9_-]+)$/;
/** WebFetch のルールにする URL のスキーム */
const WEB_FETCH_PROTOCOLS = new Set(['http:', 'https:']);
/** WebFetch のルールにするホスト名の形（`*` を含むもの・IPv6 の `[::1]` などは作らない） */
const WEB_FETCH_HOST_RE = /^[a-z0-9.-]+$/;
const WEB_FETCH_DOMAIN_PREFIX = 'domain:';
/**
 * シェルのコマンドを部分に分ける区切り（`;` `&&` `||` `|` `&` 改行 `$(` バッククォート）。
 * 「全部許可」の ask との照合（session-allow.ts）と、ルールを作らない複合コマンドの判定の両方で使う
 */
export const COMMAND_SEPARATOR_RE = /&&|\|\||[;|&\n\r`]|\$\(/;
/** リダイレクトの記号 */
const REDIRECT_RE = /[<>]/;
/** Tool / Tool(中身) の形のルール（session-allow.ts の ask との照合でも使う） */
export const RULE_RE = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/;

export type RuleResult =
  | { ok: true; rule: string; tool: string; prefix: string | undefined }
  | { ok: false; reason: string; denyHits?: string[] };

function commandOf(req: PermissionRequest): string | undefined {
  return inputField(req, 'command');
}

/** 複数のコマンドをつなぐ・リダイレクトするコマンドか */
export function isCompoundCommand(command: string): boolean {
  return COMMAND_SEPARATOR_RE.test(command) || REDIRECT_RE.test(command);
}

/**
 * 絶対パスを、Claude Code の permission rule の形（POSIX 形式・`//` 始まり）にする。
 * Windows の `C:\\dev\\foo` は `//c/dev/foo`、POSIX の `/home/a` は `//home/a`。絶対パスでなければ undefined
 */
export function toRulePath(p: string): string | undefined {
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (win) {
    const rest = (win[2] ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    return `//${(win[1] ?? '').toLowerCase()}${rest ? `/${rest}` : ''}`;
  }
  if (p.startsWith('/') && !p.startsWith('//')) return `/${p.replace(/\/+$/, '')}`;
  return undefined;
}

/** ルール用のパス（`//c/dev/foo`）を区切りで分けた段（`['c', 'dev', 'foo']`） */
function segmentsOf(rulePath: string): string[] {
  return rulePath.replace(/^\/\//, '').split('/').filter((x) => x !== '');
}

/**
 * ルール用のフォルダー（`//c/dev/foo`）が、ルールにしてよい範囲か。よければ undefined、だめなら理由。
 * windowsDrive: 最初の段がドライブ名か（深さの数え方が変わる。//c/dev/foo は 2 段）
 */
function ruleDirProblem(dir: string, windowsDrive: boolean, home: string): string | undefined {
  if (GLOB_CHARS_RE.test(dir.slice(2))) return 'パスに特殊な文字を含む';
  const segments = segmentsOf(dir);
  if (segments.some((seg) => seg === '..' || seg === '.')) return 'パスに .. や . を含む';
  const depth = windowsDrive ? segments.length - 1 : segments.length;
  if (depth < MIN_DIR_DEPTH) return 'フォルダーが浅すぎる（広すぎる）';
  const homeRule = toRulePath(home);
  if (homeRule && isSameOrAncestor(dir, homeRule)) return 'ホームフォルダーかその親は広すぎる';
  return undefined;
}

/** ルールの対象にするフォルダー。フォルダーそのもの（isDir）ならそのまま、ファイルなら親フォルダー */
function targetDirOf(raw: string, isDir: boolean): string {
  if (isDir) return raw;
  return WINDOWS_DRIVE_RE.test(raw) ? path.win32.dirname(raw) : path.posix.dirname(raw);
}

/** パスを取るツールのリクエストから、対象のフォルダー以下に絞ったルールを作る */
function derivePathRule(req: PermissionRequest, spec: PathToolSpec, home: string): RuleResult {
  const raw = inputField(req, spec.field);
  if (!raw) return { ok: false, reason: 'パスを読み取れなかった（入力が省略されているか、フォルダーの指定が無い）' };
  // `..` で範囲を広げられないよう、正規化する前の区切りごとに見る（正規化すると `..` が消える）
  if (raw.split(/[\\/]/).some((seg) => seg === '..' || seg === '.')) {
    return { ok: false, reason: `パスに .. や . を含むので作らない: ${raw}` };
  }
  const target = targetDirOf(raw, spec.isDir);
  const dir = toRulePath(target);
  if (!dir) return { ok: false, reason: `絶対パスでないので作らない: ${raw}` };
  const problem = ruleDirProblem(dir, WINDOWS_DRIVE_RE.test(target), home);
  if (problem) return { ok: false, reason: `${problem}ので作らない: ${raw}` };
  const pattern = `${dir}${PATH_RULE_SUFFIX}`;
  return { ok: true, rule: `${spec.ruleTool}(${pattern})`, tool: spec.ruleTool, prefix: pattern };
}

/** a が b と同じか、b の親（祖先）フォルダーか（大文字小文字は区別しない） */
export function isSameOrAncestor(a: string, b: string): boolean {
  const x = segmentsOf(a.toLowerCase());
  const y = segmentsOf(b.toLowerCase());
  return x.length <= y.length && x.every((seg, i) => seg === y[i]);
}

/**
 * シェルのコマンドの先頭の語を、照合に使う 1 つの名前にする。
 * 小文字にし、末尾の実行ファイルの拡張子（`.exe` `.cmd` `.bat` `.com` `.ps1`）と版番号を剥がす（`Python3.12.EXE` → `python`）。
 * PowerShell の別名（POWERSHELL_ALIASES）は本来のコマンドレットにする（`DEL` → `remove-item`）
 */
export function normalizeCommandName(word: string): string {
  const name = word.toLowerCase().replace(EXECUTABLE_EXT_RE, '').replace(VERSION_SUFFIX_RE, '');
  return POWERSHELL_ALIASES.get(name) ?? name;
}

/** シェルのプレフィックス（`rm -r`）の先頭の語を normalizeCommandName で直したもの（`remove-item -r`） */
function normalizeShellPrefix(prefix: string): string {
  const [first = '', ...rest] = prefix.toLowerCase().split(/\s+/);
  return [normalizeCommandName(first), ...rest].join(' ');
}

/** 2 つのプレフィックスの一方が他方の先頭に一致するか（大文字小文字は区別しない） */
function prefixesOverlap(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * シェルのプレフィックスどうしが重なるか。そのままの綴りか、先頭の語を正規化した綴り（`ls` と `Get-ChildItem`）のどちらかで重なれば重なる。
 * そのままの綴りでも比べるのは、正規化で重ならなくなる組（`ls` と `l`）を落とさないため
 */
function shellPrefixesOverlap(a: string, b: string): boolean {
  return prefixesOverlap(a, b) || prefixesOverlap(normalizeShellPrefix(a), normalizeShellPrefix(b));
}

/**
 * MCP の個別のツールで、名前から読み取り専用と分かるか（`mcp__github__get_issue` など）。
 * ツール名を snake_case・kebab-case・camelCase の語に分け、最初の語が READ_ONLY_MCP_VERBS にあり、MCP_WRITE_WORDS の語を
 * 含まないものだけ。ツール名の頭にサーバー名が付いていれば外して見る（`mcp__excel__excel_read_sheet` は `read_sheet`）
 */
export function isReadOnlyMcpTool(tool: string): boolean {
  const m = MCP_TOOL_RE.exec(tool);
  if (!m) return false;
  const server = (m[1] ?? '').toLowerCase();
  const name = m[2] ?? '';
  const withoutServer = name.toLowerCase().startsWith(`${server}_`) ? name.slice(server.length + 1) : name;
  const words = withoutServer
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_-]+/)
    .filter((w) => w !== '');
  return READ_ONLY_MCP_VERBS.has(words[0] ?? '') && !words.some((w) => MCP_WRITE_WORDS.has(w));
}

/** WebFetch のリクエストから、URL のホストに絞った `WebFetch(domain:<ホスト>)` を作る */
function deriveWebFetchRule(req: PermissionRequest): RuleResult {
  const raw = inputField(req, 'url');
  let url: URL;
  try {
    url = new URL(raw ?? '');
  } catch {
    return { ok: false, reason: 'URL を読み取れなかった（入力が省略されている可能性）' };
  }
  const host = url.hostname.toLowerCase();
  if (!WEB_FETCH_PROTOCOLS.has(url.protocol) || !WEB_FETCH_HOST_RE.test(host)) {
    return { ok: false, reason: `URL のホストが想定外の形: ${raw ?? ''}` };
  }
  const prefix = `${WEB_FETCH_DOMAIN_PREFIX}${host}`;
  return { ok: true, rule: `WebFetch(${prefix})`, tool: 'WebFetch', prefix };
}

/** Bash / PowerShell のリクエストから、許可リスト（SHELL_RULE_ALLOWLIST）のコマンドと引数なしで一致するものだけルールを作る */
function deriveShellRule(req: PermissionRequest, tool: string): RuleResult {
  const command = commandOf(req)?.trim();
  if (!command) return { ok: false, reason: 'コマンドを読み取れなかった（入力が省略されている可能性）' };
  if (isCompoundCommand(command)) return { ok: false, reason: '複数のコマンドをつないだ・リダイレクトを含むコマンドからは作らない' };

  const words = command.split(/\s+/).join(' ').toLowerCase();
  const entry = SHELL_RULE_ALLOWLIST.find((e) => e.toLowerCase() === words);
  if (!entry) {
    return { ok: false, reason: `許可リストのコマンドを引数なしで呼んだものではないので作らない（作れるのは ${SHELL_RULE_ALLOWLIST.join(' / ')}）` };
  }
  return { ok: true, rule: `${tool}(${entry})`, tool, prefix: entry };
}

/**
 * 実行許可のリクエストから、許可リストに足すルールの候補を作る（許可リスト方式。当てはまらなければ作らない）。
 * - Bash / PowerShell: SHELL_RULE_ALLOWLIST のコマンドを引数なしで呼んだものだけ、完全一致の `Tool(<コマンド>)` にする
 * - Read / Grep / Glob: 対象のフォルダー以下の `Read(//c/dev/foo/**)`
 * - Edit / Write / MultiEdit / NotebookEdit: 対象のフォルダー以下の `Edit(//c/dev/foo/**)`
 *   （浅すぎるフォルダー・ホームとその親・特殊な文字を含むパス・相対パスからは作らない）
 * - WebFetch: URL のホストに絞った `WebFetch(domain:example.com)`
 * - MCP の個別のツールで、名前から読み取り専用と分かるもの（isReadOnlyMcpTool）: ツール名だけのルール
 * - それ以外: 作らない
 * 作れないものは ok: false。deny との照合はここではしない（proposeRule）。ルールの種別の対応箇所。
 */
export function deriveRule(req: PermissionRequest, home: string = os.homedir()): RuleResult {
  const tool = req.tool_name.trim();
  if (!/^[A-Za-z][\w-]*$/.test(tool)) return { ok: false, reason: `ツール名が想定外の形: ${tool}` };
  const pathSpec = PATH_TOOLS.get(tool);
  if (pathSpec) return derivePathRule(req, pathSpec, home);
  if (SHELL_TOOLS.has(tool)) return deriveShellRule(req, tool);
  if (tool === 'WebFetch') return deriveWebFetchRule(req);
  if (isReadOnlyMcpTool(tool)) return { ok: true, rule: tool, tool, prefix: undefined };
  return { ok: false, reason: `ツール全体を許すルールは、読み取り専用と分かる MCP のツールにだけ作る: ${tool}` };
}

/**
 * 保存済みのルール（allow-extra.json）が、今の方式（deriveRule）で作れる形か。
 * 前の方式で足したもの（`Bash(git log:*)`・`PowerShell(npm.cmd:*)`・ツール全体の `WebFetch`・書き込みを含む MCP のツールなど）は false。
 * 種別ごとの分岐は deriveRule と対応させる。ルールの種別の対応箇所
 */
export function isDerivableRule(rule: string, home: string = os.homedir()): boolean {
  const m = RULE_RE.exec(rule);
  if (!m) return false;
  const tool = m[1] ?? '';
  const body = m[2];
  if (SHELL_TOOLS.has(tool)) return body !== undefined && SHELL_RULE_ALLOWLIST.includes(body);
  if (tool === 'Read' || tool === 'Edit') {
    if (body === undefined || !body.startsWith('//') || !body.endsWith(PATH_RULE_SUFFIX)) return false;
    const dir = body.slice(0, -PATH_RULE_SUFFIX.length);
    // toRulePath が作る形（区切りの重なりや末尾の区切りが無い）だけを受け付ける
    if (`//${segmentsOf(dir).join('/')}` !== dir) return false;
    return ruleDirProblem(dir, /^[a-z]$/.test(segmentsOf(dir)[0] ?? ''), home) === undefined;
  }
  if (tool === 'WebFetch') {
    return body !== undefined && body.startsWith(WEB_FETCH_DOMAIN_PREFIX) && WEB_FETCH_HOST_RE.test(body.slice(WEB_FETCH_DOMAIN_PREFIX.length));
  }
  return body === undefined && isReadOnlyMcpTool(tool);
}

/** 保存済みのルールを、今の方式で作れるもの（usable）と作れないもの（rejected）に分ける。順番は保つ */
export function partitionStoredRules(rules: readonly string[], home: string = os.homedir()): { usable: string[]; rejected: string[] } {
  const usable: string[] = [];
  const rejected: string[] = [];
  for (const rule of rules) (isDerivableRule(rule, home) ? usable : rejected).push(rule);
  return { usable, rejected };
}

/** 起動の知らせに並べる、作れないルールの件数の上限（超えた分は件数だけ書く） */
const REJECTED_LIST_MAX = 20;

/**
 * 保存済みのルールのうち、今の方式では作れないもの（rejected）を知らせる文。無ければ undefined。
 * 起動スクリプトはこれらを allow に入れない（allow-extra.json は書き換えない）
 */
export function buildRejectedRulesText(rejected: readonly string[]): string | undefined {
  if (rejected.length === 0) return undefined;
  const listed = rejected.slice(0, REJECTED_LIST_MAX).map((rule) => `• ${rule}`);
  const more = rejected.length > REJECTED_LIST_MAX ? [`（ほか ${rejected.length - REJECTED_LIST_MAX} 件）`] : [];
  return [
    `⚠️ allow-extra.json に、今の「今後も許可」の方式では作れないルールが ${rejected.length} 件ある。` +
      'このセッションの allow には入れていない（ファイルはそのまま）。要らなければ !rules から消す',
    ...listed,
    ...more,
  ].join('\n');
}

interface ParsedRule {
  tool: string;
  /** Tool(...) の中身（`:*` / `*` を外したもの）。中身が無ければ undefined（ツール全体） */
  body: string | undefined;
  /** Tool(...) の中身そのまま（パスのパターンの照合に使う） */
  raw: string | undefined;
}

function parseRule(rule: string): ParsedRule | undefined {
  const m = RULE_RE.exec(rule.trim());
  if (!m) return undefined;
  const raw = m[2]?.trim();
  const body = raw?.replace(/:\*$|\*$/, '').trim();
  return { tool: m[1] ?? '', body: body === '' ? undefined : body, raw: raw === '' ? undefined : raw };
}

/**
 * 保存済みの候補（`Bash(git status)` / `WebFetch(domain:example.com)`）を denyOverlaps に渡せる形に戻す。
 * パスのルールの扱いは deriveRule と対応させる。ルールの種別の対応箇所
 */
export function parseRuleForCheck(rule: string): { tool: string; prefix: string | undefined } | undefined {
  const parsed = parseRule(rule);
  if (!parsed) return undefined;
  // パスのルール（Read(//c/dev/foo/**) など）は、末尾の ** を削らずにそのまま渡す
  if (PATH_RULE_TOOLS.has(parsed.tool.toLowerCase()) && parsed.raw?.startsWith('//')) return { tool: parsed.tool, prefix: parsed.raw };
  return { tool: parsed.tool, prefix: parsed.body };
}

/** 照合に使う基準のフォルダー（deny の相対パス・`~/` の解決に使う） */
export interface DenyContext {
  /** 作業フォルダー（`./path`・`path/sub`・`/path` の基準） */
  workDir: string;
  home: string;
}

function defaultContext(): DenyContext {
  return { workDir: process.cwd(), home: os.homedir() };
}

/**
 * deny のパスのパターンが「あるフォルダー以下全部」を指すなら、そのフォルダー（ルール用のパス）を返す。
 * `//x/**`・`~/x/**`・`./x/**`・`x/y/**`・`/x/**`（作業フォルダー基準とみなす）と、末尾に `/**` の無い同じ形のフォルダー名を扱う。
 * ファイル名だけのもの（`.env`）や途中にワイルドカードがあるもの（`**\/secret/*`）は、フォルダー全体を指さないので undefined
 */
export function denyDirOf(body: string, ctx: DenyContext): string | undefined {
  // 末尾の /** と /*（直下だけ）はどちらもそのフォルダーとみなす（断る側に倒す）
  const pattern = body.replace(/\/\*{1,2}$/, '').replace(/\/+$/, '');
  if (pattern === '' || GLOB_CHARS_RE.test(pattern)) return undefined;
  if (pattern.startsWith('//')) return pattern;
  if (pattern.startsWith('~/')) {
    const home = toRulePath(ctx.home);
    return home ? `${home}/${pattern.slice(2)}` : undefined;
  }
  // gitignore では区切りを含まない名前はどの階層にも当たる（フォルダー全体の指定ではない）
  const relative = pattern.startsWith('/') ? pattern.slice(1) : pattern.replace(/^\.\//, '');
  if (!pattern.startsWith('/') && !pattern.startsWith('./') && !relative.includes('/')) return undefined;
  const base = toRulePath(ctx.workDir);
  return base ? `${base}/${relative}` : undefined;
}

/**
 * 候補のルールが deny のどれかと範囲が重なるかを調べ、重なった deny を返す（重ならなければ空）。大文字小文字は区別しない。
 * - パスのルール（`Read(//c/dev/foo/**)` / `Edit(...)`）: 候補のフォルダーが deny の範囲に丸ごと入るとき（deny がツール全体、
 *   または候補のフォルダーと同じか親のフォルダー以下全部を指すとき）だけ当たりにする。一部だけ重なる deny（`Read(.env)` など）は、
 *   Claude Code が allow より deny を優先するので許しても読めないままで、当たりにしない
 * - それ以外: 同じツールで、どちらかが全体（中身なし）か、シェルならプレフィックスの一方が他方の先頭に一致すれば重なるとみなす。
 *   シェルのプレフィックスは、先頭の語を normalizeCommandName で直しても比べる（`ls` は `PowerShell(Get-ChildItem:*)` と重なる）。
 *   シェル以外で中身のある deny（例: `Read(.env)`）は、ツール全体を許すルールと重なるとみなす
 */
export function denyOverlaps(
  candidate: { tool: string; prefix: string | undefined },
  deny: readonly string[],
  ctx: DenyContext = defaultContext()
): string[] {
  const candidateDir =
    PATH_RULE_TOOLS.has(candidate.tool.toLowerCase()) && candidate.prefix?.startsWith('//')
      ? candidate.prefix.replace(/\/\*\*$/, '')
      : undefined;
  return deny.filter((d) => {
    const parsed = parseRule(d);
    if (!parsed || parsed.tool.toLowerCase() !== candidate.tool.toLowerCase()) return false;
    return candidateDir !== undefined ? pathDenyCovers(parsed, candidateDir, ctx) : denyOverlapsPrefix(parsed, candidate);
  });
}

/** パスのルールの候補（candidateDir 以下）が、同じツールの deny の範囲に丸ごと入るか */
function pathDenyCovers(deny: ParsedRule, candidateDir: string, ctx: DenyContext): boolean {
  if (deny.body === undefined) return true;
  const denyDir = deny.raw === undefined ? undefined : denyDirOf(deny.raw, ctx);
  return denyDir !== undefined && isSameOrAncestor(denyDir, candidateDir);
}

/** パス以外のルールの候補が、同じツールの deny と重なるか（どちらかが全体か、プレフィックスの一方が他方の先頭に一致する） */
function denyOverlapsPrefix(deny: ParsedRule, candidate: { tool: string; prefix: string | undefined }): boolean {
  if (deny.body === undefined || candidate.prefix === undefined) return true;
  return SHELL_TOOLS_LOWER.has(candidate.tool.toLowerCase())
    ? shellPrefixesOverlap(candidate.prefix, deny.body)
    : prefixesOverlap(candidate.prefix, deny.body);
}

/** 候補のルールを作り、deny と重なるなら断る（重なった deny を添える） */
export function proposeRule(req: PermissionRequest, deny: readonly string[], ctx: DenyContext = defaultContext()): RuleResult {
  const derived = deriveRule(req, ctx.home);
  if (!derived.ok) return derived;
  const hits = denyOverlaps(derived, deny, ctx);
  if (hits.length > 0) {
    return { ok: false, reason: `deny に当たるので追加しない: ${derived.rule}`, denyHits: hits };
  }
  return derived;
}
