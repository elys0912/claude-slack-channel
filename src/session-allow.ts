// 「このセッション中は全部許可」の状態と判定。
// 有効な間は、settings の ask / deny に当たる操作を除き、実行許可のリクエストにブリッジが自動で allow を返す。
// 有効にできるのは .env で SESSION_ALLOW_ALL を指定したボットだけ。起動し直し・!clear・!lock で解除する。
import type { PermissionRequest } from './permission.js';

const SHELL_TOOLS = new Set(['bash', 'powershell']);
/** パスのルール（Read / Edit）がどのツールに効くか（Claude Code の permission rule と同じ対応） */
const PATH_RULE_TARGETS: Record<string, readonly string[]> = {
  read: ['read', 'grep', 'glob'],
  edit: ['edit', 'write', 'multiedit', 'notebookedit'],
};

/** input_preview（JSON）の command。JSON でない（省略されている等）・文字列でなければ undefined */
function commandOf(req: PermissionRequest): string | undefined {
  try {
    const parsed: unknown = JSON.parse(req.input_preview);
    if (typeof parsed === 'object' && parsed !== null) {
      const command = (parsed as Record<string, unknown>).command;
      if (typeof command === 'string') return command;
    }
  } catch {
    // 中身が読めないときは呼び出し側で「当たる」とみなす
  }
  return undefined;
}

/**
 * リクエストが、ask / deny のルールのどれかに当たるなら、そのルールを返す（当たらなければ undefined）。
 * 判定は安全側に倒す: ツールが同じで、ルールがツール全体・シェル以外の中身付き・コマンドが読めない、のどれかなら当たりとみなす。
 * シェル（Bash / PowerShell）の中身付きルールは、コマンドがそのプレフィックスで始まるときに当たり（大文字小文字は区別しない）。
 */
export function matchingRule(req: PermissionRequest, rules: readonly string[]): string | undefined {
  const tool = req.tool_name.trim().toLowerCase();
  for (const rule of rules) {
    const m = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/.exec(rule.trim());
    if (!m) continue;
    const ruleTool = (m[1] ?? '').toLowerCase();
    const targets = PATH_RULE_TARGETS[ruleTool] ?? [ruleTool];
    if (!targets.includes(tool)) continue;
    const body = m[2]?.trim();
    if (!body) return rule;
    if (!SHELL_TOOLS.has(tool)) return rule;
    const command = commandOf(req)?.trim().toLowerCase();
    if (command === undefined) return rule;
    const prefix = body.replace(/:\*$|\s*\*$/, '').trim().toLowerCase();
    if (command.startsWith(prefix)) return rule;
  }
  return undefined;
}

export interface SessionAllowState {
  since: Date;
  byUserId: string;
}

export class SessionAllowAll {
  private readonly loadRules: () => string[];
  private state: SessionAllowState | undefined;

  /** loadRules: 自動許可から外すルール（settings の ask と deny）。判定のたびに読み直す */
  constructor(loadRules: () => string[]) {
    this.loadRules = loadRules;
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
   * 自動で許可してよいか。無効なら false。ask / deny に当たるか、ルールを読めなければ、当たったルール（または理由）付きで false
   */
  check(req: PermissionRequest): { allow: true } | { allow: false; rule?: string | undefined } {
    if (!this.state) return { allow: false };
    let rules: string[];
    try {
      rules = this.loadRules();
    } catch {
      return { allow: false, rule: '(settings を読めなかった)' };
    }
    const hit = matchingRule(req, rules);
    return hit === undefined ? { allow: true } : { allow: false, rule: hit };
  }
}
