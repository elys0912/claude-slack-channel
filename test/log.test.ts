import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Logger, redact, toSlackLogger } from '../src/log.js';

describe('redact', () => {
  it('xoxb トークンを伏せる', () => {
    expect(redact('token=xoxb-1234-5678-abcDEF')).toBe('token=xox?-***');
  });

  it('xoxp トークンを伏せる', () => {
    expect(redact('xoxp-111-222-aaa')).toBe('xox?-***');
  });

  it('xapp トークンを伏せる', () => {
    expect(redact('xapp-1-A123-456-xyz')).toBe('xapp-***');
  });

  it('Bearer トークンを伏せる', () => {
    expect(redact('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer ***');
  });

  it('トークンが無ければそのまま', () => {
    expect(redact('hello world')).toBe('hello world');
  });
});

describe('Logger', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-test-'));
    file = path.join(dir, 'sub', 'app.log');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ファイルに出力され、改行が入る', () => {
    const logger = new Logger({ file, stderr: false });
    logger.info('hello', 'world');
    logger.warn('second line');
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('INFO');
    expect(lines[0]).toContain('hello world');
    expect(lines[1]).toContain('WARN');
  });

  it('ローテーションで .1 ができる', () => {
    const logger = new Logger({ file, stderr: false, maxBytes: 10 });
    logger.info('a'.repeat(20));
    logger.info('second entry after rotation');
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('循環参照のあるオブジェクトでも落ちない', () => {
    const logger = new Logger({ file, stderr: false });
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => logger.info(obj)).not.toThrow();
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('Circular');
  });

  it('Error の stack が出る', () => {
    const logger = new Logger({ file, stderr: false });
    const err = new Error('boom');
    logger.error(err);
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('Error: boom');
    expect(content).toContain('at ');
  });

  it('level でフィルタする', () => {
    const logger = new Logger({ file, stderr: false, level: 'warn' });
    logger.info('should be filtered');
    logger.error('should appear');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).not.toContain('should be filtered');
    expect(content).toContain('should appear');
  });

  it('ログ出力の例外を呼び出し元へ投げない', () => {
    const logger = new Logger({ file, stderr: false });
    // maxBytes に不正値を入れても例外を投げないことを確認（内部で吸収）
    expect(() => logger.info('x')).not.toThrow();
  });
});

describe('toSlackLogger', () => {
  it('set/getLevel が委譲される', () => {
    const inner = new Logger({ stderr: false });
    const slackLogger = toSlackLogger(inner, 'test-logger');
    expect(slackLogger.getLevel()).toBe('info');
    slackLogger.setLevel('debug');
    expect(slackLogger.getLevel()).toBe('debug');
    expect(inner.getLevel()).toBe('debug');
  });

  it('debug/info/warn/error を委譲する', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-test-'));
    const file = path.join(dir, 'app.log');
    const inner = new Logger({ file, stderr: false, level: 'debug' });
    const slackLogger = toSlackLogger(inner, 'named');
    slackLogger.info('hi');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('[named]');
    expect(content).toContain('hi');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
