import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  archiveKind,
  createUnique,
  defaultTarPath,
  downloadSlackFile,
  extractArchive,
  sanitizeFileName,
  splitName,
} from '../src/download.js';
import type { DownloadDeps } from '../src/download.js';
import type { SlackFile } from '../src/slack.js';

/** 1 エントリだけの tar（ustar）を作る。tar.exe では作れない `..` 入りの名前を試すため */
function tarWithEntry(name: string, content: string): Buffer {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  const put = (value: string, offset: number, length: number): void => {
    header.write(value, offset, length, 'ascii');
  };
  put(name, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12);
  put('00000000000\0', 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  const sum = header.reduce((a, b) => a + b, 0);
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded, Buffer.alloc(1024)]);
}

const LIMITS = { maxDownloadBytes: 1024 * 1024, maxBytes: 1024 * 1024, maxEntries: 1000 };
const onWindows = process.platform === 'win32';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('splitName / archiveKind', () => {
  it('二重拡張子をまとめて拡張子として扱う', () => {
    expect(splitName('a.tar.gz')).toEqual({ stem: 'a', ext: '.tar.gz' });
    expect(splitName('a.b.zip')).toEqual({ stem: 'a.b', ext: '.zip' });
    expect(splitName('README')).toEqual({ stem: 'README', ext: '' });
    expect(splitName('.zip')).toEqual({ stem: '.zip', ext: '' });
  });

  it('形式ごとに展開方式を決める', () => {
    for (const name of ['a.zip', 'a.7z', 'a.RAR', 'a.tar', 'a.tar.gz', 'a.tgz', 'a.tar.bz2', 'a.tar.xz', 'a.lzh']) {
      expect(archiveKind(name)).toBe('tar');
    }
    expect(archiveKind('a.log.gz')).toBe('gzip');
    expect(archiveKind('a.txt')).toBeUndefined();
  });
});

describe('sanitizeFileName', () => {
  it('パス区切りより前を捨てる', () => {
    expect(sanitizeFileName('../../evil.txt', 'F1')).toBe('evil.txt');
    expect(sanitizeFileName('C:\\Windows\\evil.dll', 'F1')).toBe('evil.dll');
  });

  it('Windows で使えない文字と末尾の . / 空白を処理する', () => {
    expect(sanitizeFileName('a<b>:c"|?*.txt', 'F1')).toBe('a_b__c____.txt');
    expect(sanitizeFileName('name. . ', 'F1')).toBe('name');
    expect(sanitizeFileName('a\u0001b', 'F1')).toBe('a_b');
  });

  it('空・.. なら fallback、予約名には _ を付ける', () => {
    expect(sanitizeFileName('', 'F1')).toBe('F1');
    expect(sanitizeFileName('..', 'F1')).toBe('F1');
    expect(sanitizeFileName('CON', 'F1')).toBe('_CON');
    expect(sanitizeFileName('nul.txt', 'F1')).toBe('_nul.txt');
  });

  it('長すぎる名前は拡張子を残して切る', () => {
    const name = sanitizeFileName(`${'a'.repeat(300)}.tar.gz`, 'F1');
    expect(name.length).toBe(200);
    expect(name.endsWith('.tar.gz')).toBe(true);
  });
});

describe('createUnique', () => {
  it('既にあれば (1) (2) と番号を付け、上書きしない', () => {
    fs.writeFileSync(path.join(dir, 'a.tar.gz'), 'old');
    expect(createUnique(dir, 'a.tar.gz', 'file')).toBe(path.join(dir, 'a (1).tar.gz'));
    expect(createUnique(dir, 'a.tar.gz', 'file')).toBe(path.join(dir, 'a (2).tar.gz'));
    expect(fs.readFileSync(path.join(dir, 'a.tar.gz'), 'utf8')).toBe('old');
  });

  it('フォルダーも同じように番号を付ける', () => {
    expect(createUnique(dir, 'x', 'dir')).toBe(path.join(dir, 'x'));
    expect(createUnique(dir, 'x', 'dir')).toBe(path.join(dir, 'x (1)'));
    expect(fs.statSync(path.join(dir, 'x (1)')).isDirectory()).toBe(true);
  });
});

describe('extractArchive', () => {
  it('単体の gzip を展開する', async () => {
    const gz = path.join(dir, 'log.txt.gz');
    fs.writeFileSync(gz, zlib.gzipSync('hello'));
    const r = await extractArchive(gz, dir, LIMITS);
    expect(r.path).toBe(path.join(dir, 'log.txt'));
    expect(fs.readFileSync(r.path, 'utf8')).toBe('hello');
  });

  it('gzip の展開後が上限を超えたら投げ、書きかけを消す', async () => {
    const gz = path.join(dir, 'big.bin.gz');
    fs.writeFileSync(gz, zlib.gzipSync(Buffer.alloc(10_000)));
    await expect(extractArchive(gz, dir, { ...LIMITS, maxBytes: 1000 })).rejects.toThrow(/上限/);
    expect(fs.existsSync(path.join(dir, 'big.bin'))).toBe(false);
  });

  it('対応していない形式は投げる', async () => {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'x');
    await expect(extractArchive(file, dir, LIMITS)).rejects.toThrow(/対応していない/);
  });

  describe.runIf(onWindows)('tar.exe（bsdtar）', () => {
    const tar = defaultTarPath();

    /** src の中身を archive（拡張子で形式を決める）に固める */
    function pack(archive: string, src: string, extra: string[] = []): void {
      execFileSync(tar, ['-a', '-c', '-f', archive, ...extra, '-C', src, '.'], { windowsHide: true });
    }

    function makeSource(): string {
      const src = path.join(dir, 'src');
      fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(src, 'a.txt'), 'A');
      fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'BB');
      return src;
    }

    it.each(['out.zip', 'out.tar.gz', 'out.tar.xz', 'out.7z'])('%s を名前のフォルダーに展開する', async (name) => {
      const archive = path.join(dir, name);
      pack(archive, makeSource());
      const out = path.join(dir, 'dl');
      fs.mkdirSync(out);
      const r = await extractArchive(archive, out, LIMITS, tar);
      expect(r.path).toBe(path.join(out, 'out'));
      expect(r.files).toBe(2);
      expect(r.bytes).toBe(3);
      expect(fs.readFileSync(path.join(r.path, 'sub', 'b.txt'), 'utf8')).toBe('BB');
    });

    it('手で組んだ tar でも、`..` が無ければ展開できる（下のテストの対照）', async () => {
      const archive = path.join(dir, 'plain.tar');
      fs.writeFileSync(archive, tarWithEntry('ok.txt', 'fine'));
      const r = await extractArchive(archive, dir, LIMITS, tar);
      expect(fs.readFileSync(path.join(r.path, 'ok.txt'), 'utf8')).toBe('fine');
    });

    it('`..` を含むエントリ（Zip Slip）は展開せず、展開先を消す', async () => {
      const archive = path.join(dir, 'evil.tar');
      fs.writeFileSync(archive, tarWithEntry('../escaped.txt', 'pwned'));
      const out = path.join(dir, 'dl');
      fs.mkdirSync(out);
      await expect(extractArchive(archive, out, LIMITS, tar)).rejects.toThrow();
      expect(fs.existsSync(path.join(dir, 'escaped.txt'))).toBe(false);
      expect(fs.existsSync(path.join(out, 'evil'))).toBe(false);
    });

    it('展開後の合計が上限を超えたら投げ、展開先を消す', async () => {
      const src = path.join(dir, 'src');
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, 'zero.bin'), Buffer.alloc(100_000));
      const archive = path.join(dir, 'bomb.zip');
      pack(archive, src);
      await expect(extractArchive(archive, dir, { ...LIMITS, maxBytes: 10_000 }, tar)).rejects.toThrow(/上限/);
      expect(fs.existsSync(path.join(dir, 'bomb'))).toBe(false);
    });

    it('ファイル数が上限を超えたら投げる', async () => {
      const archive = path.join(dir, 'many.zip');
      pack(archive, makeSource());
      await expect(extractArchive(archive, dir, { ...LIMITS, maxEntries: 1 }, tar)).rejects.toThrow(/ファイル数/);
    });

    it('壊れたアーカイブは tar のエラーを返す', async () => {
      const archive = path.join(dir, 'broken.zip');
      fs.writeFileSync(archive, 'not a zip');
      await expect(extractArchive(archive, dir, LIMITS, tar)).rejects.toThrow(/展開に失敗/);
      expect(fs.existsSync(path.join(dir, 'broken'))).toBe(false);
    });
  });
});

describe('downloadSlackFile', () => {
  function fakeBridge(info: Partial<SlackFile>, body: BodyInit | null): DownloadDeps['bridge'] & { fetched: number } {
    const bridge = {
      fetched: 0,
      fileInfo: async (id: string): Promise<SlackFile> => ({
        id,
        name: 'a.txt',
        size: undefined,
        mimetype: 'text/plain',
        url: 'https://files.slack.com/x',
        ...info,
      }),
      fetchFile: async (): Promise<Response> => {
        bridge.fetched += 1;
        return new Response(body);
      },
    };
    return bridge;
  }

  it('送信者のファイル名を無害化して保存先に保存する', async () => {
    const result = await downloadSlackFile({ bridge: fakeBridge({ name: '../../evil.txt' }, 'hello'), dir, limits: LIMITS }, 'F123', false);
    expect(result).toBe(`saved: ${path.join(dir, 'evil.txt')} (5 bytes)`);
    expect(fs.readFileSync(path.join(dir, 'evil.txt'), 'utf8')).toBe('hello');
  });

  it('同じ名前があれば番号を付けて保存する', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'old');
    await downloadSlackFile({ bridge: fakeBridge({}, 'new'), dir, limits: LIMITS }, 'F123', false);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('old');
    expect(fs.readFileSync(path.join(dir, 'a (1).txt'), 'utf8')).toBe('new');
  });

  it('files.info のサイズが上限を超えていれば取りに行かない', async () => {
    const bridge = fakeBridge({ size: LIMITS.maxDownloadBytes + 1 }, 'x');
    await expect(downloadSlackFile({ bridge, dir, limits: LIMITS }, 'F123', false)).rejects.toThrow(/大きすぎる/);
    expect(bridge.fetched).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('受信中に上限を超えたら止めて、書きかけを消す', async () => {
    const bridge = fakeBridge({}, Buffer.alloc(2000));
    await expect(downloadSlackFile({ bridge, dir, limits: { ...LIMITS, maxDownloadBytes: 1000 } }, 'F123', false)).rejects.toThrow(/上限/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('保存先が無ければ投げる', async () => {
    const missing = path.join(dir, 'missing');
    await expect(downloadSlackFile({ bridge: fakeBridge({}, 'x'), dir: missing, limits: LIMITS }, 'F123', false)).rejects.toThrow(/保存先/);
  });

  it('extract で gzip を展開する', async () => {
    const bridge = fakeBridge({ name: 'log.txt.gz' }, zlib.gzipSync('hello'));
    const result = await downloadSlackFile({ bridge, dir, limits: LIMITS }, 'F123', true);
    expect(result).toContain(`extracted: ${path.join(dir, 'log.txt')} (1 files, 5 bytes)`);
    expect(fs.existsSync(path.join(dir, 'log.txt.gz'))).toBe(true);
  });

  it('extract でも圧縮ファイルでなければ保存だけする', async () => {
    const result = await downloadSlackFile({ bridge: fakeBridge({}, 'x'), dir, limits: LIMITS }, 'F123', true);
    expect(result).toContain('展開していない');
  });
});
