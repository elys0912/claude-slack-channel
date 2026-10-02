import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = path.join(import.meta.dirname, '..', 'scripts', 'console.ps1');

/** powershell.exe -File で console.ps1 を実行する（ブリッジ・dialog-answer.ps1 と同じ渡し方） */
function run(...args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: r.status, stderr: r.stderr };
}

// キーを実際に送るとテストを動かしているコンソールに入力が入るので、ここでは送らずに終わる経路だけを確かめる。
// 送れることは README の「テスト」にあるシステムテスト（別のコンソールで受け取って確かめる）で見る
describe.runIf(process.platform === 'win32')('scripts/console.ps1 の -Keys', () => {
  it('カンマ区切りを 1 つずつ照合し、許可されていないキーが混ざれば何も送らずに終わる', () => {
    const r = run('-Mode', 'keys', '-Keys', 'Down,Bogus');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('送れないキー: Bogus');
    // 分割できていなければ "Down,Bogus" が 1 つの値として扱われる
    expect(r.stderr).not.toContain('Down,Bogus');
  });

  it('前後の空白は無視して照合する', () => {
    const r = run('-Mode', 'keys', '-Keys', ' Up , Nope ');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('送れないキー: Nope');
  });

  it('キーが空なら何もせずに成功する', () => {
    expect(run('-Mode', 'keys', '-Keys', '').status).toBe(0);
  });
});
