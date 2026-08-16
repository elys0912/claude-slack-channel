// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { compareShared, firstDifference, normalize, parseList } from '../scripts/shared-check.js';
import { useTempDir } from './helpers/temp-dir.js';

describe('normalize', () => {
  it('両方のチャネルの名前を同じ印にする', () => {
    expect(normalize('Slack slackbridge SLACK_CHANNEL_STATE_DIR')).toBe(normalize('Discord discordbridge DISCORD_CHANNEL_STATE_DIR'));
  });

  it('両方の repo の名前を並べた文は崩さない', () => {
    const both = '// claude-slack-channel と claude-discord-channel で同じ内容にしている';
    expect(normalize(both)).toBe('// <both-repos> で同じ内容にしている');
  });

  it('名前以外の違いは残す', () => {
    expect(normalize("'Enter'")).not.toBe(normalize("'Enter' | 'Esc'"));
  });
});

describe('parseList', () => {
  it('空行とコメントを除く', () => {
    expect(parseList('# 見出し\nsrc/a.ts\n\nsrc/b.ts  # 補足\r\n')).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('firstDifference', () => {
  it('名前の違いだけなら同じとみなす', () => {
    expect(firstDifference('// Slack に送る\n', '// Discord に送る\n')).toBeUndefined();
  });

  it('最初に違う行を返す', () => {
    expect(firstDifference('a\nb\nc', 'a\nB\nc')).toEqual({ line: 2, ours: 'b', theirs: 'B' });
  });

  it('行の数が違えば、足りない側を「行が無い」とする', () => {
    expect(firstDifference('a', 'a\nb')).toEqual({ line: 2, ours: '(行が無い)', theirs: 'b' });
  });
});

describe('compareShared', () => {
  const oursDir = useTempDir('shared-ours-');
  let ours: string;
  const theirsDir = useTempDir('shared-theirs-');
  let theirs: string;

  beforeEach(() => {
    ours = oursDir();
    theirs = theirsDir();
  });

  it('違うファイルと、相手に無いファイルを返す', () => {
    fs.writeFileSync(path.join(ours, 'same.ts'), 'Slack\n');
    fs.writeFileSync(path.join(theirs, 'same.ts'), 'Discord\n');
    fs.writeFileSync(path.join(ours, 'diff.ts'), 'x\n');
    fs.writeFileSync(path.join(theirs, 'diff.ts'), 'y\n');
    fs.writeFileSync(path.join(ours, 'only.ts'), 'z\n');

    expect(compareShared(ours, theirs, ['same.ts', 'diff.ts', 'only.ts'])).toEqual([
      { file: 'diff.ts', line: 1, ours: 'x', theirs: 'y' },
      { file: 'only.ts' },
    ]);
  });
});
