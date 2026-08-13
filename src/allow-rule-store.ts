// 「今後も許可」で足したルールの保存先（状態ディレクトリの allow-extra.json）。
// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
import fs from 'node:fs';
import path from 'node:path';
import { readJson, stringsOf } from './settings-files.js';

/** 追加分のルール（状態ディレクトリの allow-extra.json）。start.ps1 が起動時に channel-settings.json の allow へ足す */
export class AllowRuleStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** 保存済みのルール。ファイルが無い・読めないときは空（表示用。書き換えには read を使う） */
  list(): string[] {
    try {
      return this.read();
    } catch {
      return [];
    }
  }

  /** 保存済みのルール。ファイルが無ければ空、読めない・JSON でなければ投げる */
  read(): string[] {
    return stringsOf((readJson(this.file) as { allow?: unknown } | undefined)?.allow);
  }

  /** 追加する。既にあれば false。ファイルが読めない・JSON でなければ投げる（既存のルールを消さないため） */
  add(rule: string): boolean {
    const rules = this.read();
    if (rules.includes(rule)) return false;
    this.write([...rules, rule]);
    return true;
  }

  /** 消す。無ければ false。ファイルが読めない・JSON でなければ投げる */
  remove(rule: string): boolean {
    const rules = this.read();
    if (!rules.includes(rule)) return false;
    this.write(rules.filter((r) => r !== rule));
    return true;
  }

  // state-file.ts の writeFileAtomic とは一時ファイルの名前が違う。寄せると、異常終了で残る一時ファイルの名前が変わるため寄せていない
  private write(rules: string[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ allow: rules }, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}
