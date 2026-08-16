// 実行許可（permission relay）の、チャネルによらない部分（I/O なし）。
// 保留中のリクエストの管理と、表示する前の文字の整え方（不可視文字・切り詰め）。表示の形（Slack の Block Kit・Discord のカード）は permission.ts。
// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

/** input_preview（JSON）の文字列の項目。JSON でない（省略されている等）・文字列でなければ undefined */
export function inputField(req: PermissionRequest, field: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(req.input_preview);
    if (typeof parsed === 'object' && parsed !== null) {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === 'string') return value;
    }
  } catch {
    // 読めないときの扱い（ルールを作らない・当たりとみなす）は呼び出し側が決める
  }
  return undefined;
}

/** request_id の文字集合（小文字 5 文字、l を除く）。gate.ts の返信パターンもこれから組み立てる */
export const PERMISSION_ID_BODY = '[a-km-z]{5}';
export const PERMISSION_ID_RE = new RegExp(`^${PERMISSION_ID_BODY}$`);

export function isValidRequestId(id: string): boolean {
  return PERMISSION_ID_RE.test(id);
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

interface PendingEntry {
  req: PermissionRequest;
  expiresAt: number;
}

/** 保留中の permission request を TTL 付きで管理する（時刻注入でテスト可能） */
export class PendingPermissions {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly store: Map<string, PendingEntry>;

  constructor(ttlMs: number = DEFAULT_TTL_MS, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.store = new Map();
  }

  /** 有効期限（ミリ秒） */
  get ttl(): number {
    return this.ttlMs;
  }

  add(req: PermissionRequest): void {
    this.store.set(req.request_id, { req, expiresAt: this.now() + this.ttlMs });
  }

  /** 期限内なら返すだけで残す（See more 用）。期限切れならここで消して undefined */
  get(id: string): PermissionRequest | undefined {
    const entry = this.store.get(id);
    if (!entry) return undefined;
    if (this.now() > entry.expiresAt) {
      this.store.delete(id);
      return undefined;
    }
    return entry.req;
  }

  /** 取り出して消す（回答用。同じ ID に二度答えさせない）。期限切れなら消したうえで undefined */
  take(id: string): PermissionRequest | undefined {
    const entry = this.store.get(id);
    if (!entry) return undefined;
    this.store.delete(id);
    if (this.now() > entry.expiresAt) return undefined;
    return entry.req;
  }

  /** 期限に関係なく取り出して消す（自動 deny 用） */
  remove(id: string): PermissionRequest | undefined {
    const entry = this.store.get(id);
    this.store.delete(id);
    return entry?.req;
  }

  prune(): void {
    const t = this.now();
    for (const [id, entry] of this.store) {
      if (t > entry.expiresAt) this.store.delete(id);
    }
  }
}

/** input_preview を表示する長さの既定（超えたら先頭と末尾を残して間を省略する） */
export const DEFAULT_PREVIEW_LIMIT = 2800;

/**
 * 表示を偽装できる不可視文字。承認画面で実際と違う内容に見せられないよう、`\u{202E}` の形で見えるようにする。
 * - 双方向制御: U+202A-202E / U+2066-2069 と、向きの印 U+200E-200F / U+061C
 * - ゼロ幅・結合制御: U+200B-200D / U+2060-2064 / U+034F / U+180E、BOM U+FEFF
 * - 空白に見える埋め文字: U+00AD（ソフトハイフン）/ U+115F-1160 / U+17B4-17B5 / U+2800（点字の空白）/ U+3164 / U+FFA0
 * - 行・段落の区切り: U+2028-2029
 * - 異体字セレクタ: U+FE00-FE0F / U+E0100-E01EF、タグ文字: U+E0000-E007F
 * - 注釈・楽譜の書式制御: U+FFF9-FFFB / U+1D173-1D17A
 * - C0・C1 制御文字（タブ・改行・復帰は除く）: U+0000-0008 / U+000B-000C / U+000E-001F / U+007F-009F
 * 補助面の文字（U+1xxxx 以降）も 1 文字として照合するよう u フラグを付ける（toVisibleUnits はコードポイント単位で渡す）
 */
// 制御文字・不可視文字をわざと列挙しているので、それらを禁じる lint は外す
const INVISIBLE_RE =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{1D173}-\u{1D17A}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;

function visibleUnit(ch: string): string {
  if (!INVISIBLE_RE.test(ch)) return ch;
  return `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase()}}`;
}

/** 表示単位（コードポイント 1 つ、または不可視文字のエスケープ 1 つ）に分ける。途中で切ってもサロゲートやエスケープが割れない */
function toVisibleUnits(text: string): string[] {
  return Array.from(text, visibleUnit);
}

/** 不可視文字を `\u{XXXX}` に置き換える（See more の全文表示でも使う） */
export function revealInvisible(text: string): string {
  return toVisibleUnits(text).join('');
}

/** units の先頭から、UTF-16 長の合計が budget 以内に収まるだけ取る */
function takeHead(units: readonly string[], budget: number): string[] {
  const out: string[] = [];
  let len = 0;
  for (const u of units) {
    if (len + u.length > budget) break;
    out.push(u);
    len += u.length;
  }
  return out;
}

/** units の末尾から、UTF-16 長の合計が budget 以内に収まるだけ取る（並びは元の順） */
function takeTail(units: readonly string[], budget: number): string[] {
  return takeHead(units.slice().reverse(), budget).reverse();
}

function unitsLength(units: readonly string[]): number {
  return units.reduce((n, u) => n + u.length, 0);
}

/** 不可視文字を見えるようにしたうえで、maxLen 以内に先頭だけ残して切り詰める */
export function truncatePlain(text: string, maxLen: number): { text: string; truncated: boolean } {
  const units = toVisibleUnits(text);
  if (unitsLength(units) <= maxLen) return { text: units.join(''), truncated: false };
  return { text: takeHead(units, Math.max(0, maxLen - 1)).join('') + '…', truncated: true };
}

/** 切り詰めたプレビューの末尾側に残す割合（既定 2800 なら 省略表示を除いて 先頭 約 2200 + 末尾 約 600） */
const PREVIEW_TAIL_RATIO = 0.22;

/**
 * input_preview 用: 長いときは先頭と末尾の両方を残し、間に省略した文字数を入れる。
 * コマンドの末尾に危険な部分を置いて先頭だけ見せる、という偽装を防ぐため。
 */
export function truncateHeadTail(text: string, maxLen: number): { text: string; truncated: boolean } {
  const units = toVisibleUnits(text);
  const total = unitsLength(units);
  if (total <= maxLen) return { text: units.join(''), truncated: false };

  // 省略表示の桁数は total 以下なので、total で見積もれば長さの上限を超えない
  const marker = (n: number) => `\n…（途中 ${n} 文字省略）…\n`;
  const budget = Math.max(0, maxLen - marker(total).length);
  const tailBudget = Math.floor(budget * PREVIEW_TAIL_RATIO);
  const head = takeHead(units, budget - tailBudget);
  const tail = takeTail(units.slice(head.length), tailBudget);
  const omitted = total - unitsLength(head) - unitsLength(tail);
  return { text: head.join('') + marker(omitted) + tail.join(''), truncated: true };
}

export const PREVIEW_TRUNCATED_WARNING =
  '⚠️ 入力が長いため途中を省略している。許可する前に See more で全文を確認すること';

/** 空（空白だけ）の欄は、代わりの文言にして表示する */
export function orPlaceholder(text: string, placeholder: string): string {
  return text.trim() === '' ? placeholder : text;
}
