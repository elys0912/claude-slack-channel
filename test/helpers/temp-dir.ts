// テストごとの一時フォルダー。describe の中で呼ぶと、beforeEach で作り afterEach で消す登録をまとめて行う。
// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'vitest';

/**
 * 一時フォルダー（`<OS の一時フォルダー>/<prefix><乱数>`）を各テストの前に作り、後に消す。
 * 戻り値の関数は、いま実行中のテストのフォルダーを返す（beforeEach・it の中で呼ぶ）
 */
export function useTempDir(prefix: string): () => string {
  let dir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  });

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  return () => {
    if (dir === undefined) throw new Error('useTempDir のフォルダーは beforeEach か it の中で使う');
    return dir;
  };
}
