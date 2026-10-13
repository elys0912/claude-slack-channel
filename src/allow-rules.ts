// Slack から許可リスト（allow）にルールを恒久追加するための、ルールの生成・安全確認・保存。
// ルールは実行許可のリクエストの中身からだけ作り、自由な入力は受け付けない。
// 作るのは決まった一覧（SHELL_RULE_ALLOWLIST など）に当てはまるものだけで、広すぎるもの・deny と重なるものも作らない
// （Slack アカウントの乗っ取りで何でも無確認実行されるのを防ぐ）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PermissionRequest } from './permission.js';
import { stripBom } from './text.js';
import { errMessage } from './errors.js';

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * パスを取るツール。ツール全体ではなく、対象のフォルダー以下に絞ったルールにする。
 * Claude Code がパスで照合するのは Read(path) と Edit(path) だけなので、ルールはこの 2 つのどちらかで作る
 * （Edit のルールはファイルを書き換える組み込みツール全部に、Read のルールは Grep / Glob にも効く）。
 * - field: 入力のうちパスの項目
 * - isDir: パスがフォルダーそのものか（Grep / Glob）。false ならファイルなので、その親フォルダーにする
 */
const PATH_TOOLS: ReadonlyMap<string, { ruleTool: 'Read' | 'Edit'; field: string; isDir: boolean }> = new Map([
  ['Read', { ruleTool: 'Read', field: 'file_path', isDir: false }],
  ['Grep', { ruleTool: 'Read', field: 'path', isDir: true }],
  ['Glob', { ruleTool: 'Read', field: 'path', isDir: true }],
  ['Edit', { ruleTool: 'Edit', field: 'file_path', isDir: false }],
  ['Write', { ruleTool: 'Edit', field: 'file_path', isDir: false }],
  ['MultiEdit', { ruleTool: 'Edit', field: 'file_path', isDir: false }],
  ['NotebookEdit', { ruleTool: 'Edit', field: 'notebook_path', isDir: false }],
]);
/** パスで照合されるルールのツール */
const PATH_RULE_TOOLS = new Set(['read', 'edit']);
/** フォルダーの深さ（ドライブ・ルートの下の段数）がこれ未満なら、広すぎるので作らない（例: //c/dev は 1 段） */
const MIN_DIR_DEPTH = 2;
/** gitignore のパターンで特別な意味を持つ文字。含むパスからは作らない（エスケープの取り違えで範囲が変わるのを避ける） */
const GLOB_CHARS_RE = /[*?[\]!#{}\\]/;
/**
 * 「♾ 今後も許可」でルールにしてよいシェルのコマンド（許可リスト方式。ここに無いものは作らない）。
 * キーは先頭の語を normalizeCommandName で正規化した名前。値はサブコマンドの一覧で、undefined なら先頭の語だけのルールにする。
 * 引数でファイルの中身を読めない・書けない・コードを実行しないものだけを置く（docs/security.md の「今後も許可で作れるルール」と揃える）
 */
export const SHELL_RULE_ALLOWLIST: ReadonlyMap<string, readonly string[] | undefined> = new Map<string, readonly string[] | undefined>([
  ['ls', undefined],
  ['dir', undefined],
  ['pwd', undefined],
  ['get-location', undefined],
  ['get-childitem', undefined],
  ['git', ['status', 'log', 'branch']],
]);
/**
 * ツール全体のルールにしてよい MCP の個別ツールの、名前の先頭の動詞（読み取り専用と分かるもの）。
 * `mcp__<サーバー>__<ツール>` のツール名（サーバー名の接頭辞は外す）の先頭の英小文字の並びで照合する
 */
export const READ_ONLY_MCP_VERBS: ReadonlySet<string> = new Set(['get', 'list', 'read', 'search', 'find', 'describe', 'view', 'show']);
/** WebFetch のルールにする URL のスキーム */
const WEB_FETCH_PROTOCOLS = new Set(['http:', 'https:']);
/** 先頭の語から剥がす実行ファイルの拡張子 */
const COMMAND_EXT_RE = /\.(exe|cmd|bat|com|ps1)$/;
/** 先頭の語の末尾の版番号（`python3.12` の `3.12`）。英字の直後の数字だけを剥がす */
const COMMAND_VERSION_RE = /(?<=[a-z])\d+(\.\d+)*$/;
/** 複数のコマンドをつなぐ・リダイレクトする記号 */
const COMPOUND_RE = /&&|\|\||[;|<>`\n\r]|\$\(|&\s*$|^\s*&/;

/**
 * コマンドの先頭の語を、判定に使う 1 つの名前にする。小文字にし、末尾の `.exe` `.cmd` `.bat` `.com` `.ps1` と版番号を剥がす
 * （例: `Git.EXE` → `git`、`python3.12` → `python`、`npm.cmd` → `npm`）
 */
export function normalizeCommandName(word: string): string {
  return word.toLowerCase().replace(COMMAND_EXT_RE, '').replace(COMMAND_VERSION_RE, '');
}

export type RuleResult =
  | { ok: true; rule: string; tool: string; prefix: string | undefined }
  | { ok: false; reason: string; denyHits?: string[] };

/** input_preview（JSON）の文字列の項目。JSON でない（省略されている等）・文字列でなければ undefined */
function inputField(req: PermissionRequest, field: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(req.input_preview);
    if (typeof parsed === 'object' && parsed !== null) {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === 'string') return value;
    }
  } catch {
    // input_preview が JSON でない（省略されている等）ときは作らない
  }
  return undefined;
}

function commandOf(req: PermissionRequest): string | undefined {
  return inputField(req, 'command');
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

/** パスを取るツールのリクエストから、対象のフォルダー以下に絞ったルールを作る */
function derivePathRule(req: PermissionRequest, spec: { ruleTool: 'Read' | 'Edit'; field: string; isDir: boolean }, home: string): RuleResult {
  const raw = inputField(req, spec.field);
  if (!raw) return { ok: false, reason: 'パスを読み取れなかった（入力が省略されているか、フォルダーの指定が無い）' };
  // `..` で範囲を広げられないよう、正規化する前の区切りごとに見る（正規化すると `..` が消える）
  if (raw.split(/[\\/]/).some((seg) => seg === '..' || seg === '.')) {
    return { ok: false, reason: `パスに .. や . を含むので作らない: ${raw}` };
  }
  const target = spec.isDir ? raw : /^[A-Za-z]:/.test(raw) ? path.win32.dirname(raw) : path.posix.dirname(raw);
  const dir = toRulePath(target);
  if (!dir) return { ok: false, reason: `絶対パスでないので作らない: ${raw}` };
  if (GLOB_CHARS_RE.test(dir.slice(2))) return { ok: false, reason: `パスに特殊な文字を含むので作らない: ${raw}` };

  const segments = segmentsOf(dir);
  // Windows はドライブ名の段を除いて数える（//c/dev/foo は 2 段）
  const depth = /^[a-z]$/.test(segments[0] ?? '') && /^[A-Za-z]:/.test(target) ? segments.length - 1 : segments.length;
  if (depth < MIN_DIR_DEPTH) return { ok: false, reason: `フォルダーが浅すぎる（広すぎる）ので作らない: ${raw}` };
  const homeRule = toRulePath(home);
  if (homeRule && isSameOrAncestor(dir, homeRule)) {
    return { ok: false, reason: `ホームフォルダーかその親は広すぎるので作らない: ${raw}` };
  }
  const pattern = `${dir}/**`;
  return { ok: true, rule: `${spec.ruleTool}(${pattern})`, tool: spec.ruleTool, prefix: pattern };
}

/** a が b と同じか、b の親（祖先）フォルダーか（大文字小文字は区別しない） */
export function isSameOrAncestor(a: string, b: string): boolean {
  const x = segmentsOf(a.toLowerCase());
  const y = segmentsOf(b.toLowerCase());
  return x.length <= y.length && x.every((seg, i) => seg === y[i]);
}

/** シェルのリクエストから、SHELL_RULE_ALLOWLIST にあるコマンドだけ `Tool(prefix:*)` を作る */
function deriveShellRule(req: PermissionRequest, tool: string): RuleResult {
  const command = commandOf(req)?.trim();
  if (!command) return { ok: false, reason: 'コマンドを読み取れなかった（入力が省略されている可能性）' };
  if (COMPOUND_RE.test(command)) return { ok: false, reason: '複数のコマンドをつないだ・リダイレクトを含むコマンドからは作らない' };

  const words = command.split(/\s+/);
  const first = words[0] ?? '';
  if (!/^[A-Za-z][\w.-]*$/.test(first)) {
    return { ok: false, reason: `コマンド名が想定外の形: ${first}` };
  }
  const name = normalizeCommandName(first);
  if (!SHELL_RULE_ALLOWLIST.has(name)) {
    return { ok: false, reason: `許可リストに追加できるコマンドではない: ${first}` };
  }
  const subcommands = SHELL_RULE_ALLOWLIST.get(name);
  if (subcommands === undefined) return { ok: true, rule: `${tool}(${first}:*)`, tool, prefix: first };

  const second = words[1];
  if (second === undefined || !subcommands.includes(second)) {
    return { ok: false, reason: `許可リストに追加できるサブコマンドではない: ${first} ${second ?? ''}（追加できるのは ${subcommands.join(' / ')}）`.trim() };
  }
  const prefix = `${first} ${second}`;
  return { ok: true, rule: `${tool}(${prefix}:*)`, tool, prefix };
}

/** WebFetch のリクエストから、URL のホストに絞った `WebFetch(domain:<ホスト>)` を作る */
function deriveWebFetchRule(req: PermissionRequest, tool: string): RuleResult {
  const raw = inputField(req, 'url');
  let url: URL;
  try {
    url = new URL(raw ?? '');
  } catch {
    return { ok: false, reason: 'URL を読み取れなかった（入力が省略されている可能性）' };
  }
  const host = url.hostname.toLowerCase();
  if (!WEB_FETCH_PROTOCOLS.has(url.protocol) || !/^[a-z0-9.-]+$/.test(host)) {
    return { ok: false, reason: `URL のホストが想定外の形: ${raw ?? ''}` };
  }
  const prefix = `domain:${host}`;
  return { ok: true, rule: `${tool}(${prefix})`, tool, prefix };
}

/** `mcp__<サーバー>__<ツール>` のうち、名前の先頭の動詞が READ_ONLY_MCP_VERBS にあるものか */
export function isReadOnlyMcpTool(tool: string): boolean {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (!m) return false;
  const server = m[1] ?? '';
  const name = m[2] ?? '';
  const withoutServer = name.toLowerCase().startsWith(`${server.toLowerCase()}_`) ? name.slice(server.length + 1) : name;
  const verb = /^[a-z]+/.exec(withoutServer)?.[0];
  return verb !== undefined && READ_ONLY_MCP_VERBS.has(verb);
}

/**
 * 実行許可のリクエストから、許可リストに足すルールの候補を作る（許可リスト方式。当てはまらなければ作らない）。
 * - Bash / PowerShell: SHELL_RULE_ALLOWLIST の先頭の語（＋サブコマンド）だけ `Tool(prefix:*)` にする。複合コマンドからは作らない
 * - Read / Grep / Glob: 対象のフォルダー以下の `Read(//c/dev/foo/**)`
 * - Edit / Write / MultiEdit / NotebookEdit: 対象のフォルダー以下の `Edit(//c/dev/foo/**)`
 *   （浅すぎるフォルダー・ホームとその親・特殊な文字を含むパス・相対パスからは作らない）
 * - WebFetch: URL のホストに絞った `WebFetch(domain:example.com)`
 * - MCP の個別ツール: 名前から読み取り専用と分かるもの（isReadOnlyMcpTool）だけ、ツール名だけのルール
 * - それ以外: 作らない
 * 作れないものは ok: false。deny との照合はここではしない（proposeRule）。
 */
export function deriveRule(req: PermissionRequest, home: string = os.homedir()): RuleResult {
  const tool = req.tool_name.trim();
  if (!/^[A-Za-z][\w-]*$/.test(tool)) return { ok: false, reason: `ツール名が想定外の形: ${tool}` };
  const pathSpec = PATH_TOOLS.get(tool);
  if (pathSpec) return derivePathRule(req, pathSpec, home);
  if (SHELL_TOOLS.has(tool)) return deriveShellRule(req, tool);
  if (tool === 'WebFetch') return deriveWebFetchRule(req, tool);
  if (isReadOnlyMcpTool(tool)) return { ok: true, rule: tool, tool, prefix: undefined };
  return { ok: false, reason: `このツールは許可リストに追加できない: ${tool}` };
}

interface ParsedRule {
  tool: string;
  /** Tool(...) の中身（`:*` / `*` を外したもの）。中身が無ければ undefined（ツール全体） */
  body: string | undefined;
  /** Tool(...) の中身そのまま（パスのパターンの照合に使う） */
  raw: string | undefined;
}

function parseRule(rule: string): ParsedRule | undefined {
  const m = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return undefined;
  const raw = m[2]?.trim();
  const body = raw?.replace(/:\*$|\*$/, '').trim();
  return { tool: m[1] ?? '', body: body === '' ? undefined : body, raw: raw === '' ? undefined : raw };
}

/** 保存済みの候補（`Bash(git status:*)` / `WebFetch`）を denyOverlaps に渡せる形に戻す */
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
 *   シェル以外で中身のある deny（例: `Read(.env)`）は、ツール全体を許すルールと重なるとみなす
 */
export function denyOverlaps(
  candidate: { tool: string; prefix: string | undefined },
  deny: readonly string[],
  ctx: DenyContext = defaultContext()
): string[] {
  const hits: string[] = [];
  const candidateDir =
    PATH_RULE_TOOLS.has(candidate.tool.toLowerCase()) && candidate.prefix?.startsWith('//')
      ? candidate.prefix.replace(/\/\*\*$/, '')
      : undefined;
  for (const d of deny) {
    const parsed = parseRule(d);
    if (!parsed || parsed.tool.toLowerCase() !== candidate.tool.toLowerCase()) continue;
    if (candidateDir !== undefined) {
      const denyDir = parsed.raw === undefined ? undefined : denyDirOf(parsed.raw, ctx);
      if (parsed.body === undefined || (denyDir !== undefined && isSameOrAncestor(denyDir, candidateDir))) hits.push(d);
      continue;
    }
    if (parsed.body === undefined || candidate.prefix === undefined) {
      hits.push(d);
      continue;
    }
    const a = candidate.prefix.toLowerCase();
    const b = parsed.body.toLowerCase();
    if (a.startsWith(b) || b.startsWith(a)) hits.push(d);
  }
  return hits;
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

/**
 * JSON ファイルを読む（BOM 付きでも可）。ファイルが無ければ undefined。
 * 読めない・JSON でないときは投げる（壊れたファイルを「空」と取り違えて、deny の照合抜けや既存ルールの消失を起こさないため）
 */
function readJson(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${file} を読めない: ${errMessage(e)}`, { cause: e });
  }
  try {
    return JSON.parse(stripBom(text)) as unknown;
  } catch (e) {
    throw new Error(`${file} の JSON 構文が不正: ${errMessage(e)}`, { cause: e });
  }
}

/** 配列のうち文字列だけを返す（配列でなければ空） */
function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** 設定ファイル（Claude Code の settings JSON）の permissions.deny を読む。ファイルが無ければ空、読めない・JSON でなければ投げる */
export function readDeny(file: string): string[] {
  return stringsOf((readJson(file) as { permissions?: { deny?: unknown } } | undefined)?.permissions?.deny);
}

/** 設定ファイルの permissions.ask を読む。ファイルが無ければ空、読めない・JSON でなければ投げる */
export function readAsk(file: string): string[] {
  return stringsOf((readJson(file) as { permissions?: { ask?: unknown } } | undefined)?.permissions?.ask);
}

/** 追加分のルール（状態ディレクトリの allow-extra.json）。start.ps1 が起動時に channel-settings.json の allow へ足す */
export class AllowRuleStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** 保存済みのルール。ファイルが無い・読めないときは空（表示用。書き換えには read を使う） */
  list(): string[] {
    try {
      return this.read();
    } catch {
      return [];
    }
  }

  /** 追加する。既にあれば false。ファイルが読めない・JSON でなければ投げる（既存のルールを消さないため） */
  add(rule: string): boolean {
    const rules = this.read();
    if (rules.includes(rule)) return false;
    this.write([...rules, rule]);
    return true;
  }

  /** 消す。無ければ false。ファイルが読めない・JSON でなければ投げる */
  remove(rule: string): boolean {
    const rules = this.read();
    if (!rules.includes(rule)) return false;
    this.write(rules.filter((r) => r !== rule));
    return true;
  }

  /** ファイルが無ければ空、読めない・JSON でなければ投げる */
  private read(): string[] {
    return stringsOf((readJson(this.file) as { allow?: unknown } | undefined)?.allow);
  }

  private write(rules: string[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ allow: rules }, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}
