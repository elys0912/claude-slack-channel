// Slack から許可リスト（allow）にルールを恒久追加するための、ルールの生成・安全確認・保存。
// ルールは実行許可のリクエストの中身からだけ作り、自由な入力は受け付けない。
// 広すぎるもの・危険なもの・deny と重なるものは作らない（Slack アカウントの乗っ取りで何でも無確認実行されるのを防ぐ）。
import fs from 'node:fs';
import path from 'node:path';
import type { PermissionRequest } from './permission.js';

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** ファイル編集はルールで恒久許可せず、許可モード（acceptEdits など）で扱う */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** 2 語目（サブコマンド）までをプレフィックスにするコマンド */
const SUBCOMMAND_TOOLS = new Set(['git', 'npm', 'pnpm', 'yarn', 'cargo', 'dotnet', 'go', 'uv', 'pip', 'winget']);

/** 先頭の語がこれなら作らない（削除・ネットワーク・プロセス起動・任意コード実行・権限昇格など） */
const DANGEROUS_COMMANDS = new Set([
  // 削除・移動・書き換え
  'rm', 'del', 'erase', 'rd', 'rmdir', 'ri', 'mv', 'move', 'ren', 'rename', 'cp', 'copy', 'xcopy', 'robocopy',
  'format', 'diskpart', 'cipher', 'takeown', 'icacls', 'attrib', 'mklink', 'sc', 'ac',
  // ネットワーク
  'curl', 'wget', 'iwr', 'irm', 'ssh', 'scp', 'sftp', 'ftp', 'nc', 'ncat', 'telnet',
  // プロセス・シェル・任意コード実行
  'start', 'saps', 'kill', 'taskkill', 'spps', 'iex', 'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'wsl',
  'node', 'deno', 'bun', 'python', 'python3', 'py', 'ruby', 'perl', 'php', 'java', 'npx', 'pnpx', 'bunx',
  'uvx', 'pipx', 'code',
  // エージェントの CLI（別のエージェントに確認なしで任意の操作をさせられる）
  'claude', 'codex', 'gemini', 'aider', 'goose', 'opencode', 'cursor-agent', 'copilot',
  'rundll32', 'regsvr32', 'mshta', 'cscript', 'wscript', 'msiexec', 'schtasks', 'at',
  // 権限・システム
  'sudo', 'runas', 'reg', 'shutdown', 'bcdedit', 'net', 'netsh', 'setx',
  // 外部サービス
  'gh', 'docker', 'kubectl', 'az', 'aws', 'gcloud', 'terraform',
]);
/** サブコマンドまで見て作らないもの */
const DANGEROUS_SUBCOMMANDS = new Set([
  'git push', 'git reset', 'git clean', 'git rebase', 'git checkout', 'git restore', 'git rm', 'git stash',
  'git filter-branch', 'git gc', 'git update-ref', 'git config', 'git remote', 'git submodule', 'git worktree',
  // package.json などのスクリプトを実行するもの（ファイル編集が無確認なら、スクリプトを書き換えてから実行できる）
  'npm publish', 'npm unpublish', 'npm uninstall', 'npm remove', 'npm rm', 'npm exec', 'npm x', 'npm run', 'npm install', 'npm i',
  'npm test', 'npm t', 'npm start', 'npm restart', 'npm stop', 'npm ci',
  'pnpm publish', 'pnpm remove', 'pnpm exec', 'pnpm dlx', 'pnpm run', 'pnpm test', 'pnpm start', 'pnpm install', 'pnpm add',
  'yarn publish', 'yarn remove', 'yarn dlx', 'yarn run', 'yarn test', 'yarn start', 'yarn add', 'yarn install',
  'cargo publish', 'cargo install', 'cargo run', 'cargo test', 'cargo build', 'dotnet nuget', 'dotnet run', 'dotnet test', 'dotnet build',
  'go install', 'go run', 'go test', 'go generate', 'uv run', 'uv pip', 'uv tool', 'uv sync', 'pip install', 'pip uninstall',
  'winget install', 'winget uninstall',
]);
/** PowerShell のコマンドレット（動詞-名詞）で許す動詞（読み取り系） */
const SAFE_VERBS = new Set(['get', 'test', 'select', 'measure', 'resolve', 'compare', 'find', 'convertto', 'convertfrom', 'format', 'sort', 'group', 'where']);
/** 複数のコマンドをつなぐ・リダイレクトする記号 */
const COMPOUND_RE = /&&|\|\||[;|<>`\n\r]|\$\(|&\s*$|^\s*&/;

export type RuleResult =
  | { ok: true; rule: string; tool: string; prefix: string | undefined }
  | { ok: false; reason: string; denyHits?: string[] };

function commandOf(req: PermissionRequest): string | undefined {
  try {
    const parsed: unknown = JSON.parse(req.input_preview);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { command?: unknown }).command === 'string') {
      return (parsed as { command: string }).command;
    }
  } catch {
    // input_preview が JSON でない（省略されている等）ときは作らない
  }
  return undefined;
}

/**
 * 実行許可のリクエストから、許可リストに足すルールの候補を作る。
 * - Bash / PowerShell: コマンドの先頭の語（SUBCOMMAND_TOOLS は 2 語目まで）を `Tool(prefix:*)` にする
 * - Write / Edit など: 作らない（許可モードで扱う）
 * - それ以外: ツール名だけのルール（例: `WebFetch`、`mcp__server__tool`）
 * 危険なコマンド・複合コマンド・プレフィックスが取れないものは ok: false。deny との照合はここではしない（checkAgainstDeny）。
 */
export function deriveRule(req: PermissionRequest): RuleResult {
  const tool = req.tool_name.trim();
  if (!/^[A-Za-z][\w-]*$/.test(tool)) return { ok: false, reason: `ツール名が想定外の形: ${tool}` };
  if (EDIT_TOOLS.has(tool)) return { ok: false, reason: 'ファイル編集は許可リストではなく許可モード（acceptEdits など）で扱う' };
  if (!SHELL_TOOLS.has(tool)) return { ok: true, rule: tool, tool, prefix: undefined };

  const command = commandOf(req)?.trim();
  if (!command) return { ok: false, reason: 'コマンドを読み取れなかった（入力が省略されている可能性）' };
  if (COMPOUND_RE.test(command)) return { ok: false, reason: '複数のコマンドをつないだ・リダイレクトを含むコマンドからは作らない' };

  const words = command.split(/\s+/);
  const first = (words[0] ?? '').replace(/^["']|["']$/g, '');
  const firstLower = first.toLowerCase();
  if (!/^[A-Za-z][\w.-]*$/.test(first) || /[\\/]/.test(first)) {
    return { ok: false, reason: `コマンド名が想定外の形: ${first}` };
  }
  if (DANGEROUS_COMMANDS.has(firstLower) || DANGEROUS_COMMANDS.has(firstLower.replace(/\.exe$/, ''))) {
    return { ok: false, reason: `危険なコマンドなので作らない: ${first}` };
  }
  const cmdlet = /^([A-Za-z]+)-[A-Za-z]+$/.exec(first);
  if (cmdlet && !SAFE_VERBS.has((cmdlet[1] ?? '').toLowerCase())) {
    return { ok: false, reason: `読み取り系でないコマンドレットなので作らない: ${first}` };
  }

  let prefix = first;
  const second = words[1];
  if (SUBCOMMAND_TOOLS.has(firstLower)) {
    if (!second || !/^[a-z][a-z0-9-]*$/.test(second)) {
      return { ok: false, reason: `${first} のサブコマンドが取れないので作らない（広すぎるため）` };
    }
    prefix = `${first} ${second}`;
    if (DANGEROUS_SUBCOMMANDS.has(`${firstLower} ${second}`)) {
      return { ok: false, reason: `危険な操作なので作らない: ${prefix}` };
    }
  }
  return { ok: true, rule: `${tool}(${prefix}:*)`, tool, prefix };
}

interface ParsedRule {
  tool: string;
  /** Tool(...) の中身（`:*` / `*` を外したもの）。中身が無ければ undefined（ツール全体） */
  body: string | undefined;
}

function parseRule(rule: string): ParsedRule | undefined {
  const m = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return undefined;
  const body = m[2]?.replace(/:\*$|\*$/, '').trim();
  return { tool: m[1] ?? '', body: body === '' ? undefined : body };
}

/** 保存済みの候補（`Bash(git status:*)` / `WebFetch`）を denyOverlaps に渡せる形に戻す */
export function parseRuleForCheck(rule: string): { tool: string; prefix: string | undefined } | undefined {
  const parsed = parseRule(rule);
  return parsed ? { tool: parsed.tool, prefix: parsed.body } : undefined;
}

/**
 * 候補のルールが deny のどれかと範囲が重なるかを調べ、重なった deny を返す（重ならなければ空）。
 * 同じツールで、どちらかが全体（中身なし）か、シェルならプレフィックスの一方が他方の先頭に一致すれば重なるとみなす。
 * シェル以外で中身のある deny（例: `Read(.env)`）は、ツール全体を許すルールと重なるとみなす。大文字小文字は区別しない。
 */
export function denyOverlaps(candidate: { tool: string; prefix: string | undefined }, deny: readonly string[]): string[] {
  const hits: string[] = [];
  for (const d of deny) {
    const parsed = parseRule(d);
    if (!parsed || parsed.tool.toLowerCase() !== candidate.tool.toLowerCase()) continue;
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
export function proposeRule(req: PermissionRequest, deny: readonly string[]): RuleResult {
  const derived = deriveRule(req);
  if (!derived.ok) return derived;
  const hits = denyOverlaps(derived, deny);
  if (hits.length > 0) {
    return { ok: false, reason: `deny に当たるので追加しない: ${derived.rule}`, denyHits: hits };
  }
  return derived;
}

/** 設定ファイル（Claude Code の settings JSON）の permissions.deny を読む。読めなければ空 */
export function readDeny(file: string): string[] {
  try {
    const json: unknown = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const deny = (json as { permissions?: { deny?: unknown } }).permissions?.deny;
    return Array.isArray(deny) ? deny.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

/** 追加分のルール（状態ディレクトリの allow-extra.json）。start.ps1 が起動時に channel-settings.json の allow へ足す */
export class AllowRuleStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  list(): string[] {
    try {
      const json: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^﻿/, ''));
      const allow = (json as { allow?: unknown }).allow;
      return Array.isArray(allow) ? allow.filter((r): r is string => typeof r === 'string') : [];
    } catch {
      return [];
    }
  }

  /** 追加する。既にあれば false */
  add(rule: string): boolean {
    const rules = this.list();
    if (rules.includes(rule)) return false;
    this.write([...rules, rule]);
    return true;
  }

  /** 消す。無ければ false */
  remove(rule: string): boolean {
    const rules = this.list();
    if (!rules.includes(rule)) return false;
    this.write(rules.filter((r) => r !== rule));
    return true;
  }

  private write(rules: string[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ allow: rules }, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}
