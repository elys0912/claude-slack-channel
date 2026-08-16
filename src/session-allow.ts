// 「このセッション中は全部許可」の状態と判定。
// 有効な間は、settings の ask に当たる操作を除き、実行許可のリクエストにブリッジが自動で allow を返す。
// deny に当たる操作は Claude Code が確認を出す前に止めるので、ここまで届かない（照合しない）。
// 有効にできるのは .env で SESSION_ALLOW_ALL を指定したボットだけ。起動し直し・!clear・!lock で解除する。
// ask との照合は、判断できないものを当たり（自動許可しない）に倒す。
// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
import path from 'node:path';
import { inputField } from './permission-core.js';
import type { PermissionRequest } from './permission-core.js';
import { COMMAND_SEPARATOR_RE, RULE_RE, defaultContext, denyDirOf, isSameOrAncestor, normalizeCommandName, normalizeShellWords, toRulePath } from './allow-rules.js';
import type { DenyContext } from './allow-rules.js';

/** シェルのツール（小文字）。ルールの種別の対応箇所（allow-rules.ts の SHELL_TOOLS） */
const SHELL_TOOLS = new Set(['bash', 'powershell']);
/** パスのルール（Read / Edit）がどのツールに効くか（Claude Code の permission rule と同じ対応）。ルールの種別の対応箇所 */
const PATH_RULE_TARGETS: Record<string, readonly string[]> = {
  read: ['read', 'grep', 'glob'],
  edit: ['edit', 'write', 'multiedit', 'notebookedit'],
};
/** 行の継続（Bash の `\` + 改行、PowerShell のバッククォート + 改行）。部分に分ける前に空白にする */
const LINE_CONTINUATION_RE = /[\\`]\r?\n/g;
/**
 * 含んでいれば、コマンドの組み立てを解釈しない（当たりにする）文字。引用符（`git "push"`）・バッククォート（`` git `push ``）・
 * 波かっこ（`{ git push }`）・丸かっこ（`if (...)`・`$(...)`）
 */
const UNPARSEABLE_CHARS_RE = /["'`{}()]/;
/**
 * 含んでいれば、コマンドの組み立てを解釈しない（当たりにする）語（小文字）。制御構文と、スクリプトブロックを取るコマンドレットとその別名
 * （ForEach-Object の `foreach` / `%`、Where-Object の `where` / `?`）。
 * `then git push` や `do git push` のように、部分の先頭がこれらになるものを照合から漏らさない
 */
const CONTROL_WORDS = new Set([
  'if', 'then', 'elif', 'else', 'fi', 'for', 'foreach', 'while', 'until', 'do', 'done', 'case', 'esac', 'select',
  'function', 'try', 'catch', 'finally', 'trap', 'switch', 'foreach-object', '%', 'where-object', 'where', '?',
]);
/** 部分の先頭の環境変数の代入（`FOO=1 git push`） */
const ENV_ASSIGNMENT_RE = /^[a-z_]\w*=/;
/** 照合できる先頭の語の形（パス・変数などで始まるものは解釈しない） */
const PLAIN_COMMAND_RE = /^[a-z][\w.-]*$/;
/** 展開で別の語になりうる文字（変数・ワイルドカード）。ルールのサブコマンドの位置にあれば当たりにする */
const EXPANSION_CHARS_RE = /[$*?[\]]/;
/**
 * 後ろの語を別のコマンドとして実行するもの。部分の先頭がこれなら、何を実行するかを解釈しない（当たりにする）。
 * 先頭の語は normalizeCommandName で直してから引くので、PowerShell の別名（`start` / `saps` / `iex` / `icm` / `sajb`）は
 * 本来のコマンドレットの名前で当たる。ここには別名を書かない
 */
const WRAPPER_COMMANDS = new Set([
  'env', 'sudo', 'runas', 'timeout', 'time', 'nohup', 'nice', 'xargs', 'watch', 'command', 'builtin', 'exec', 'eval', 'source',
  'sh', 'bash', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh', 'wsl', 'call', 'start-process',
  'invoke-expression', 'invoke-command', 'start-job', 'npx', 'pnpx', 'bunx', 'uvx',
]);
/** ファイル名だけのパターンで、正規表現に直す前にエスケープする文字（* と ? はワイルドカードとして別に扱う） */
const REGEX_SPECIAL_RE = /[.+^$()|]/g;

/** パスを取るツールのパス（file_path / path / notebook_path）。読めなければ undefined（呼び出し側で当たりとみなす） */
function pathOf(req: PermissionRequest): string | undefined {
  return inputField(req, 'file_path') ?? inputField(req, 'path') ?? inputField(req, 'notebook_path');
}

/** ファイル名だけのパターン（`.env`・`*.pem` など。区切りを含まない）を正規表現にする。* と ? 以外の特殊文字があれば undefined */
function namePatternRe(pattern: string): RegExp | undefined {
  if (pattern.includes('/') || /[[\]{}!#\\]/.test(pattern)) return undefined;
  const source = pattern
    .replace(REGEX_SPECIAL_RE, (c) => `\\${c}`)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${source}$`, 'i');
}

/**
 * パスのルール（Read / Edit の中身付き）にリクエストのパスが当たるか。判断できないときは当たりにする（安全側）。
 * - `**\/name` / `name`（ファイル名だけ）: パスの最後の名前が一致すれば当たり
 * - フォルダー以下全部（`//x/**`・`~/x/**`・`./x/**` など）: パスがそのフォルダー以下なら当たり
 */
function pathRuleMatches(body: string, req: PermissionRequest, ctx: DenyContext): boolean {
  const raw = pathOf(req);
  const target = raw === undefined ? undefined : toRulePath(raw);
  if (target === undefined) return true;
  const nameRe = namePatternRe(body.replace(/^\*\*\//, ''));
  if (nameRe) return nameRe.test(path.posix.basename(target));
  const dir = denyDirOf(body, ctx);
  if (dir === undefined) return true;
  return isSameOrAncestor(dir, target);
}

/**
 * コマンドの 1 つの部分（小文字にしたもの）が、ask のルールの語の並び（先頭の語は正規化済み）に当たるか。
 * - 先頭が環境変数の代入・照合できない形の語・ラッパー（WRAPPER_COMMANDS）なら当たり
 * - 部分のどこかに、ルールの語の並びが続いていれば当たり（`echo git push` も当たる。確認が出るだけなので安全側）。
 *   語はバックスラッシュを取り除き、コマンド名の位置は normalizeCommandName で正規化して比べる（`git.exe push`・`git pus\h` も当たる。
 *   PowerShell の別名も直すので、`del x` は `Remove-Item` のルールに当たる）
 * - ルールの先頭の語と同じ語の後ろが、オプション（`git -C x push`）か、展開で変わりうる語（`git $x`・`git pu*`）なら当たり
 */
function shellPartMatches(part: string, ruleWords: readonly string[]): boolean {
  const words = part.split(/\s+/).map((w) => w.replace(/\\/g, ''));
  const first = words[0] ?? '';
  if (ENV_ASSIGNMENT_RE.test(first) || !PLAIN_COMMAND_RE.test(first)) return true;
  if (WRAPPER_COMMANDS.has(normalizeCommandName(first))) return true;
  const [ruleName = '', ...ruleRest] = ruleWords;
  return words.some((word, i) => {
    if (normalizeCommandName(word) !== ruleName) return false;
    const rest = words.slice(i + 1);
    if (ruleRest.length === 0) return true;
    if ((rest[0] ?? '').startsWith('-')) return true;
    if (rest.slice(0, ruleRest.length).some((w) => EXPANSION_CHARS_RE.test(w))) return true;
    return rest.join(' ').startsWith(ruleRest.join(' '));
  });
}

/**
 * シェルのコマンドが ask のプレフィックス（`:*` と末尾の `*` を外したもの）に当たるか。次のどれかなら当たり。
 * - プレフィックスが空か、途中にワイルドカードを含む（解釈しない）
 * - コマンドが引用符・バッククォート・波かっこ・丸かっこ・制御構文の語を含む（組み立てを解釈しない）
 * - 行の継続をつないでから区切り（COMMAND_SEPARATOR_RE）で分けた部分のどれかが shellPartMatches に当たる
 */
function shellCommandMatches(command: string, prefix: string): boolean {
  if (prefix === '' || prefix.includes('*')) return true;
  const text = command.replace(LINE_CONTINUATION_RE, ' ').toLowerCase();
  if (UNPARSEABLE_CHARS_RE.test(text)) return true;
  const parts = text
    .split(COMMAND_SEPARATOR_RE)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.some((part) => part.split(/\s+/).some((word) => CONTROL_WORDS.has(word)))) return true;
  const ruleWords = normalizeShellWords(prefix);
  return parts.some((part) => shellPartMatches(part, ruleWords));
}

/**
 * MCP のルール（`mcp__<サーバー>` / `mcp__<サーバー>__*` / `mcp__<サーバー>__<ツール>`）がツール（小文字）に当たるか。
 * MCP のルールでなければ undefined
 */
function mcpRuleMatches(rule: string, tool: string): boolean | undefined {
  const name = rule.trim().toLowerCase();
  if (!name.startsWith('mcp__')) return undefined;
  const scope = name.endsWith('__*') ? name.slice(0, -'__*'.length) : name;
  return tool === scope || tool.startsWith(`${scope}__`);
}

/**
 * リクエストが、ask のルールのどれかに当たるなら、そのルールを返す（当たらなければ undefined）。大文字小文字は区別しない。
 * - ツール全体のルール: そのツールの全リクエストに当たる
 * - MCP のルール: `mcp__<サーバー>` と `mcp__<サーバー>__*` は、そのサーバーの全ツールに当たる
 * - シェル（Bash / PowerShell）の中身付き: shellCommandMatches。コマンドが読めなければ当たり
 * - Read / Edit の中身付き: pathRuleMatches（パスが読めない・複雑なパターンなら当たり）
 * - それ以外のツールの中身付き（WebFetch(domain:...) など）: 判断できないので当たり
 * - 形の読めないルール: 判断できないので、どのリクエストにも当たり
 */
export function matchingRule(req: PermissionRequest, rules: readonly string[], ctx: DenyContext = defaultContext()): string | undefined {
  const tool = req.tool_name.trim().toLowerCase();
  return rules.find((rule) => ruleMatches(rule, req, tool, ctx));
}

/** 1 本のルールがリクエストに当たるか（tool はリクエストのツール名の小文字）。種別ごとの扱いは matchingRule の説明のとおり */
function ruleMatches(rule: string, req: PermissionRequest, tool: string, ctx: DenyContext): boolean {
  const mcp = mcpRuleMatches(rule, tool);
  if (mcp !== undefined) return mcp;

  const m = RULE_RE.exec(rule.trim());
  if (!m) return true;
  const ruleTool = (m[1] ?? '').toLowerCase();
  const pathTargets = PATH_RULE_TARGETS[ruleTool];
  if (!(pathTargets ?? [ruleTool]).includes(tool)) return false;
  const body = m[2]?.trim();
  if (!body) return true;
  if (pathTargets) return pathRuleMatches(body, req, ctx);
  if (!SHELL_TOOLS.has(tool)) return true;

  const command = inputField(req, 'command')?.trim();
  if (command === undefined) return true;
  const prefix = body.replace(/:\*$|\s*\*$/, '').trim();
  return shellCommandMatches(command, prefix);
}

export interface SessionAllowState {
  since: Date;
  byUserId: string;
}

export class SessionAllowAll {
  private readonly loadRules: () => string[];
  private readonly ctx: DenyContext;
  private state: SessionAllowState | undefined;

  /** loadRules: 自動許可から外すルール（settings の ask）。判定のたびに読み直す */
  constructor(loadRules: () => string[], ctx: DenyContext = defaultContext()) {
    this.loadRules = loadRules;
    this.ctx = ctx;
  }

  get current(): SessionAllowState | undefined {
    return this.state;
  }

  enable(byUserId: string, now: Date = new Date()): void {
    this.state ??= { since: now, byUserId };
  }

  /** 解除する。有効だったら true */
  disable(): boolean {
    const was = this.state !== undefined;
    this.state = undefined;
    return was;
  }

  /**
   * ask のルールを読めるか。読めない（設定ファイルが読めない・JSON でない）なら、
   * 何を自動許可から外すべきか判断できないので false
   */
  available(): boolean {
    try {
      this.loadRules();
      return true;
    } catch {
      return false;
    }
  }

  /** 全部許可のボタンを出してよいか。まだ有効になっておらず、ask を読める（available）とき */
  canOffer(): boolean {
    return this.state === undefined && this.available();
  }

  /**
   * 自動で許可してよいか。無効なら false。ask に当たるか、ルールを読めなければ、当たったルール（または理由）付きで false
   */
  check(req: PermissionRequest): { allow: true } | { allow: false; rule?: string | undefined } {
    if (!this.state) return { allow: false };
    let rules: string[];
    try {
      rules = this.loadRules();
    } catch {
      return { allow: false, rule: '(settings を読めなかった)' };
    }
    const hit = matchingRule(req, rules, this.ctx);
    return hit === undefined ? { allow: true } : { allow: false, rule: hit };
  }
}
