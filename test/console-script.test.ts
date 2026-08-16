import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { PowerShellConsole } from '../src/console.js';
import { Logger } from '../src/log.js';
import { describeOnWindows, runPowerShellFile } from './helpers/powershell.js';

const script = path.join(import.meta.dirname, '..', 'scripts', 'console.ps1');

/** powershell.exe -File で console.ps1 を実行する（ブリッジ・dialog-answer.ps1 と同じ渡し方） */
function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = runPowerShellFile(script, args);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// キーを実際に送るとテストを動かしているコンソールに入力が入るので、ここでは送らずに終わる経路だけを確かめる。
// 送れることは docs/development.md の「テスト」にあるシステムテスト（別のコンソールで受け取って確かめる）で見る
describeOnWindows('scripts/console.ps1 の -Keys', 30000, () => {
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

describeOnWindows('scripts/console.ps1 の -TargetPid', 30000, () => {
  it('別のコンソールを持つプロセスに付け直して、その画面を読む', async () => {
    const marker = `TARGET-${process.pid}-${Date.now()}`;
    // 非表示の新しいコンソールで、マーカーを書いて待つだけの PowerShell を動かす（読み取り対象の別コンソール）
    const started = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-Command','Write-Host ${marker}; Start-Sleep -Seconds 30').Id`,
      ],
      { encoding: 'utf8', windowsHide: true }
    );
    const target = Number.parseInt(started.stdout.trim(), 10);
    expect(Number.isInteger(target)).toBe(true);
    try {
      let screen = '';
      for (let i = 0; i < 20 && !screen.includes(marker); i++) {
        await new Promise((r) => setTimeout(r, 300));
        screen = run('-Mode', 'read', '-TargetPid', String(target)).stdout;
      }
      expect(screen).toContain(marker);
    } finally {
      process.kill(target);
    }
  }, 30000);

  it('付け直せない pid なら知らせて、自分のコンソールで続ける', () => {
    const r = run('-Mode', 'read', '-TargetPid', '999999');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('pid=999999 のコンソールに付けられなかった');
  });
});

describeOnWindows('PowerShellConsole（console.ps1 の警告をログに残す）', 30000, () => {
  it('付け直せず console.ps1 が 0 で終わっても、stderr の警告を logger.warn に残す', async () => {
    const logger = new Logger({ stderr: false });
    const warn = vi.spyOn(logger, 'warn');
    await new PowerShellConsole(script, 999999, logger).read();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pid=999999 のコンソールに付けられなかった'));
  });
});
