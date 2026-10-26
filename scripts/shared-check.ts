// 相手の repo（claude-slack-channel ⇔ claude-discord-channel）と同じ内容にしているファイル（shared-files.txt）が、
// チャネルの名前の違いを除いて同じかを確かめる。CI の shared-check ジョブから実行する（初めは警告だけ）。
// 使い方: node dist/scripts/shared-check.js <相手の repo のパス>
// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 同じ内容にしているファイルの一覧（repo のルートからの相対パス。# から後ろはコメント） */
export const SHARED_LIST = 'shared-files.txt';

/**
 * チャネルの名前を中立な印に置き換える。両方の repo の内容に同じ置き換えをしてから比べる。
 * 両方の repo の名前を並べた文（「claude-slack-channel と claude-discord-channel」）は、置き換えると片方だけ崩れるので先に印にする
 */
export function normalize(text: string): string {
  return text
    .replaceAll('claude-slack-channel と claude-discord-channel', '<both-repos>')
    .replace(/slack|discord/g, '<ch>')
    .replace(/Slack|Discord/g, '<Ch>')
    .replace(/SLACK|DISCORD/g, '<CH>');
}

/** 一覧の文から、ファイルのパスを取り出す（空行と # のコメントは除く） */
export function parseList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => line !== '');
}

export interface Mismatch {
  file: string;
  /** 最初に違う行（1 始まり）。相手に無いときは undefined */
  line?: number | undefined;
  ours?: string | undefined;
  theirs?: string | undefined;
}

/** 名前をそろえた 2 つの内容を比べ、最初に違う行を返す。同じなら undefined */
export function firstDifference(ours: string, theirs: string): { line: number; ours: string; theirs: string } | undefined {
  const a = normalize(ours).split(/\r?\n/);
  const b = normalize(theirs).split(/\r?\n/);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return { line: i + 1, ours: a[i] ?? '(行が無い)', theirs: b[i] ?? '(行が無い)' };
  }
  return undefined;
}

/** 一覧のファイルを相手の repo と比べ、違うものを返す */
export function compareShared(ourRoot: string, theirRoot: string, files: string[]): Mismatch[] {
  const mismatches: Mismatch[] = [];
  for (const file of files) {
    const ours = fs.readFileSync(path.join(ourRoot, file), 'utf8');
    let theirs: string;
    try {
      theirs = fs.readFileSync(path.join(theirRoot, file), 'utf8');
    } catch {
      mismatches.push({ file });
      continue;
    }
    const diff = firstDifference(ours, theirs);
    if (diff) mismatches.push({ file, ...diff });
  }
  return mismatches;
}

function main(): void {
  const theirRoot = process.argv[2];
  if (!theirRoot) {
    process.stderr.write('使い方: node dist/scripts/shared-check.js <相手の repo のパス>\n');
    process.exit(2);
  }
  const ourRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const files = parseList(fs.readFileSync(path.join(ourRoot, SHARED_LIST), 'utf8'));
  const mismatches = compareShared(ourRoot, theirRoot, files);

  // GitHub Actions では、PR の画面にも出るよう警告の注釈にする
  const annotate = process.env.GITHUB_ACTIONS === 'true';
  for (const m of mismatches) {
    if (m.line === undefined) {
      process.stdout.write(`${m.file}: 相手の repo に無い\n`);
      if (annotate) process.stdout.write(`::warning file=${m.file}::相手の repo に無い\n`);
    } else {
      process.stdout.write(`${m.file}:${m.line}: 相手と違う\n  こちら: ${m.ours}\n  相手:   ${m.theirs}\n`);
      if (annotate) process.stdout.write(`::warning file=${m.file},line=${m.line}::相手の repo と違う\n`);
    }
  }
  process.stdout.write(`${files.length} 件のうち ${mismatches.length} 件が相手と違う\n`);
  if (mismatches.length > 0) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
