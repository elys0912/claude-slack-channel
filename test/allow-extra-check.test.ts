// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAllowExtraCheck } from '../src/allow-extra-check.js';

const HOME = 'C:\\Users\\me';

describe('runAllowExtraCheck（start.ps1 が allow に足すルールを選ぶ）', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allow-extra-check-'));
    file = path.join(dir, 'allow-extra.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('今の方式で作れるものを usable、作れないもの（前の方式で足したもの）を rejected にし、ファイルは書き換えない', () => {
    const text = JSON.stringify({ allow: ['Bash(git status)', 'PowerShell(npm.cmd:*)', 'Bash(git log:*)', 'WebFetch', 'Read(//c/dev/foo/**)'] });
    fs.writeFileSync(file, text);
    const { code, output } = runAllowExtraCheck(file, HOME);
    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual({
      usable: ['Bash(git status)', 'Read(//c/dev/foo/**)'],
      rejected: ['PowerShell(npm.cmd:*)', 'Bash(git log:*)', 'WebFetch'],
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  it('ファイルが無ければ両方とも空', () => {
    expect(JSON.parse(runAllowExtraCheck(file, HOME).output)).toEqual({ usable: [], rejected: [] });
  });

  it('壊れていれば error と終了コード 1（start.ps1 は追加のルールを使わない）', () => {
    fs.writeFileSync(file, '{ broken');
    const { code, output } = runAllowExtraCheck(file, HOME);
    expect(code).toBe(1);
    expect(JSON.parse(output)).toEqual({ error: expect.stringContaining('JSON 構文が不正') });
  });

  it('ASCII の外の文字は \\uXXXX にして書く（Windows PowerShell 5.1 がコンソールの文字コードで読んでも化けない）', () => {
    fs.writeFileSync(file, JSON.stringify({ allow: ['Read(//c/dev/資料/**)'] }));
    const { output } = runAllowExtraCheck(file, HOME);
    expect(output).toMatch(/^[\x20-\x7e]*$/);
    expect(JSON.parse(output)).toEqual({ usable: ['Read(//c/dev/資料/**)'], rejected: [] });
  });
});
