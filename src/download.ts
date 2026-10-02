// Slack の添付を保存・展開する（download_file ツールの実体）。Slack への問い合わせは SlackBridge に任せる。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import type { SlackBridge, SlackFile } from './slack.js';

const BYTES_PER_GIB = 1024 ** 3;
/** ダウンロードの上限（Slack にアップロードできる上限と同じ 1GB） */
export const MAX_DOWNLOAD_BYTES = BYTES_PER_GIB;
/** 展開後の合計サイズの上限（ZIP 爆弾対策） */
export const MAX_EXTRACT_BYTES = 4 * BYTES_PER_GIB;
/** 展開後のファイル数の上限 */
export const MAX_EXTRACT_ENTRIES = 100_000;
/** ダウンロード全体のタイムアウト */
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
/** 展開中に、展開先の合計サイズ・ファイル数を確かめる間隔 */
const EXTRACT_POLL_MS = 500;
/** 保存するファイル名の長さの上限（拡張子を残して本体を切る） */
const MAX_NAME_LENGTH = 200;
/** エラーに載せる tar の標準エラーの長さ */
const STDERR_MAX = 500;

/** tar.exe（bsdtar / libarchive）で展開する拡張子。.tar.gz を .gz より先に当てるため、長いものから並べる */
const TAR_EXTENSIONS = [
  '.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst',
  '.tgz', '.tbz2', '.tbz', '.txz', '.tzst',
  '.tar', '.zip', '.7z', '.rar', '.lzh', '.lha',
];
/** tar ではない単体の gzip（Node の zlib で展開する） */
const GZIP_EXTENSION = '.gz';

export type ArchiveKind = 'tar' | 'gzip';

export interface ExtractLimits {
  maxBytes: number;
  maxEntries: number;
}

export const DEFAULT_LIMITS: ExtractLimits & { maxDownloadBytes: number } = {
  maxDownloadBytes: MAX_DOWNLOAD_BYTES,
  maxBytes: MAX_EXTRACT_BYTES,
  maxEntries: MAX_EXTRACT_ENTRIES,
};

/** 拡張子（.tar.gz などの二重拡張子を含む）と、それより前の部分に分ける */
export function splitName(name: string): { stem: string; ext: string } {
  const lower = name.toLowerCase();
  const archiveExt = [...TAR_EXTENSIONS, GZIP_EXTENSION].find((e) => lower.endsWith(e) && lower.length > e.length);
  const ext = archiveExt ? name.slice(-archiveExt.length) : path.extname(name);
  return { stem: name.slice(0, name.length - ext.length), ext };
}

/** 名前から展開の方式を決める。対応していない形式なら undefined */
export function archiveKind(name: string): ArchiveKind | undefined {
  const lower = name.toLowerCase();
  if (TAR_EXTENSIONS.some((e) => lower.endsWith(e))) return 'tar';
  if (lower.endsWith(GZIP_EXTENSION)) return 'gzip';
  return undefined;
}

const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
// eslint-disable-next-line no-control-regex -- 制御文字をファイル名から取り除くため
const UNSAFE_NAME_CHARS_RE = /[<>:"|?*\u0000-\u001f]/g;

/**
 * 送信者が自由に付けられるファイル名を、保存先フォルダーの中の 1 ファイル名にする。
 * パス区切りより前は捨て（`../` や絶対パスで外に出さない）、Windows で使えない文字は _ に、末尾の . と空白は削る。
 * 予約名（CON / NUL など）には _ を前に付け、空になったら fallback を使う
 */
export function sanitizeFileName(name: string, fallback: string): string {
  let safe = (name.split(/[\\/]/).pop() ?? '').replace(UNSAFE_NAME_CHARS_RE, '_').trim().replace(/[. ]+$/, '');
  if (safe === '') safe = fallback;
  if (WINDOWS_RESERVED_RE.test(safe)) safe = `_${safe}`;
  if (safe.length > MAX_NAME_LENGTH) {
    const { stem, ext } = splitName(safe);
    safe = stem.slice(0, Math.max(1, MAX_NAME_LENGTH - ext.length)) + ext.slice(0, MAX_NAME_LENGTH - 1);
  }
  return safe;
}

/**
 * dir の中に name のファイルかフォルダーを作り、そのパスを返す。既にあれば `名前 (1).拡張子` のように番号を付ける。
 * 作成と存在確認を 1 回の操作で行う（wx / mkdir）ので、同時に呼ばれても上書きしない
 */
export function createUnique(dir: string, name: string, kind: 'file' | 'dir'): string {
  const { stem, ext } = splitName(name);
  for (let n = 0; ; n++) {
    const candidate = path.join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
    try {
      if (kind === 'file') fs.closeSync(fs.openSync(candidate, 'wx'));
      else fs.mkdirSync(candidate);
      return candidate;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

/** エラー文に載せる長さに収める */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 通過したバイト数を数え、上限を超えたらエラーで止める */
function byteLimiter(maxBytes: number, what: string): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      total += chunk.length;
      if (total > maxBytes) done(new Error(`${what}が上限（${maxBytes} バイト）を超えた`));
      else done(null, chunk);
    },
  });
}

/** stream を file に書き出す。失敗したら書きかけのファイルを消す */
async function writeLimited(source: Readable, file: string, maxBytes: number, what: string): Promise<number> {
  try {
    await pipeline(source, byteLimiter(maxBytes, what), fs.createWriteStream(file));
  } catch (e) {
    await fsp.rm(file, { force: true });
    throw e;
  }
  return (await fsp.stat(file)).size;
}

/** Windows では Git などの GNU tar を拾わないよう、OS 付属の bsdtar を絶対パスで使う */
export function defaultTarPath(): string {
  if (process.platform !== 'win32') return 'bsdtar';
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}

interface TreeStat {
  files: number;
  bytes: number;
  /** シンボリックリンク・ジャンクション（展開先の外を指せるので認めない） */
  links: string[];
}

async function statTree(dir: string): Promise<TreeStat> {
  const result: TreeStat = { files: 0, bytes: 0, links: [] };
  const entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) {
      result.links.push(path.relative(dir, full));
      continue;
    }
    if (!entry.isFile()) continue;
    result.files += 1;
    try {
      result.bytes += (await fsp.lstat(full)).size;
    } catch {
      // 展開中に消えた・名前が変わったファイルは次の確認で数える
    }
  }
  return result;
}

export interface ExtractResult {
  /** 展開先（tar はフォルダー、gzip は展開したファイル） */
  path: string;
  files: number;
  bytes: number;
}

/**
 * archive を destParent の中に展開する。tar は `<名前>` フォルダーを作ってその中へ、gzip は `<名前>` のファイルへ。
 * パスに `..` を含むエントリ・絶対パスは bsdtar の既定（-P なし）で拒否され、展開後にもリンクが無いことを確かめる。
 * 上限を超えた・tar が失敗した・リンクがあったときは、展開しかけたものを消して投げる
 */
export async function extractArchive(
  archive: string,
  destParent: string,
  limits: ExtractLimits,
  tarPath: string = defaultTarPath()
): Promise<ExtractResult> {
  const name = path.basename(archive);
  const kind = archiveKind(name);
  if (!kind) throw new Error(`展開に対応していない形式: ${name}`);
  const { stem } = splitName(name);

  if (kind === 'gzip') {
    const out = createUnique(destParent, stem, 'file');
    const bytes = await writeLimited(fs.createReadStream(archive).pipe(zlib.createGunzip()), out, limits.maxBytes, '展開後のサイズ');
    return { path: out, files: 1, bytes };
  }

  const dir = createUnique(destParent, stem, 'dir');
  try {
    await runTar(tarPath, archive, dir, limits);
    const tree = await statTree(dir);
    if (tree.links.length > 0) throw new Error(`アーカイブにリンクが含まれている: ${clip(tree.links.join(', '), STDERR_MAX)}`);
    assertWithin(tree, limits);
    return { path: dir, files: tree.files, bytes: tree.bytes };
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw e;
  }
}

function assertWithin(tree: TreeStat, limits: ExtractLimits): void {
  if (tree.bytes > limits.maxBytes) throw new Error(`展開後のサイズが上限（${limits.maxBytes} バイト）を超えた`);
  if (tree.files > limits.maxEntries) throw new Error(`展開後のファイル数が上限（${limits.maxEntries} 個）を超えた`);
}

/** tar を走らせ、展開先が上限を超えたら止める */
async function runTar(tarPath: string, archive: string, dir: string, limits: ExtractLimits): Promise<void> {
  const child = spawn(tarPath, ['-x', '-f', archive, '-C', dir], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (s: string) => {
    if (stderr.length < STDERR_MAX) stderr += s;
  });

  let overLimit: Error | undefined;
  let checking = false;
  const timer = setInterval(() => {
    if (checking || overLimit) return;
    checking = true;
    void statTree(dir)
      .then(
        (tree) => {
          try {
            assertWithin(tree, limits);
          } catch (e) {
            overLimit = e as Error;
            child.kill();
          }
        },
        () => {
          // 展開中で読み取りに失敗しただけなら次の確認に任せる（終わった後にも確かめる）
        }
      )
      .finally(() => {
        checking = false;
      });
  }, EXTRACT_POLL_MS);

  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (overLimit) throw overLimit;
    if (code !== 0) throw new Error(`展開に失敗（tar code=${code}）: ${clip(stderr.trim(), STDERR_MAX)}`);
  } finally {
    clearInterval(timer);
  }
}

export interface DownloadDeps {
  bridge: Pick<SlackBridge, 'fileInfo' | 'fetchFile'>;
  /** 保存先（.env の DOWNLOAD_DIR） */
  dir: string;
  limits?: (ExtractLimits & { maxDownloadBytes: number }) | undefined;
  tarPath?: string | undefined;
}

/** Slack のファイルを dir に保存し、extract なら展開もする。Claude に返す結果の文面を返す */
export async function downloadSlackFile(deps: DownloadDeps, fileId: string, extract: boolean): Promise<string> {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const dirStat = await fsp.stat(deps.dir).catch(() => undefined);
  if (!dirStat?.isDirectory()) throw new Error(`保存先のフォルダーが無い: ${deps.dir}`);

  const info: SlackFile = await deps.bridge.fileInfo(fileId);
  if (info.size !== undefined && info.size > limits.maxDownloadBytes) {
    throw new Error(`ファイルが大きすぎる（${info.size} バイト、上限 ${limits.maxDownloadBytes} バイト）`);
  }

  const target = createUnique(deps.dir, sanitizeFileName(info.name, fileId), 'file');
  let bytes: number;
  try {
    const res = await deps.bridge.fetchFile(info, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS));
    if (!res.body) throw new Error('ダウンロードの本文が空');
    bytes = await writeLimited(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), target, limits.maxDownloadBytes, 'ダウンロードのサイズ');
  } catch (e) {
    await fsp.rm(target, { force: true });
    throw e;
  }

  const lines = [`saved: ${target} (${bytes} bytes)`];
  if (extract) {
    if (archiveKind(target)) {
      const r = await extractArchive(target, deps.dir, limits, deps.tarPath);
      lines.push(`extracted: ${r.path} (${r.files} files, ${r.bytes} bytes)`);
    } else {
      lines.push('extract: 圧縮ファイルではないので展開していない');
    }
  }
  return lines.join('\n');
}
