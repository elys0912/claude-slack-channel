// 起動スクリプトから呼ぶコマンド（node dist/src/allow-extra-check.js <allow-extra.json>）。
// 保存済みの「今後も許可」のルールを、今の方式で作れるもの（usable）と作れないもの（rejected）に分け、
// stdout に JSON を 1 行で書く。start.ps1（common.ps1 の Read-AllowExtra）は usable だけを allow に足す。allow-extra.json は書き換えない。
// - 読めた: {"usable": [...], "rejected": [...]}（ファイルが無ければ両方とも空）で exit 0
// - 読めない・JSON でない: {"error": "<理由>"} で exit 1
// Windows PowerShell 5.1 は外部コマンドの出力をコンソールの文字コードで読むので、ASCII 以外の文字は \uXXXX にして書く。
// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
import { pathToFileURL } from 'node:url';
import { partitionStoredRules } from './allow-rules.js';
import { AllowRuleStore } from './allow-rule-store.js';
import { errMessage } from './errors.js';

/** ASCII の外の文字（制御文字の DEL を含む） */
const NON_ASCII_RE = /[\u007f-￿]/g;
const UNICODE_ESCAPE_DIGITS = 4;
const HEX_RADIX = 16;

/** JSON の文字列にし、ASCII の外の文字を \uXXXX にする（JSON として同じ値のまま） */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(NON_ASCII_RE, (c) => `\\u${c.charCodeAt(0).toString(HEX_RADIX).padStart(UNICODE_ESCAPE_DIGITS, '0')}`);
}

/** allow-extra.json を読んで分け、stdout に書く 1 行と終了コードを返す。投げない */
export function runAllowExtraCheck(file: string, home?: string): { code: number; output: string } {
  try {
    const result = partitionStoredRules(new AllowRuleStore(file).read(), home);
    return { code: 0, output: asciiJson(result) };
  } catch (e) {
    return { code: 1, output: asciiJson({ error: errMessage(e) }) };
  }
}

function main(): void {
  const file = process.argv[2];
  const { code, output } = file ? runAllowExtraCheck(file) : { code: 1, output: asciiJson({ error: 'allow-extra.json のパスが無い' }) };
  process.stdout.write(`${output}\n`);
  process.exitCode = code;
}

// コマンドとして直接起動されたときだけ動く（テストや他モジュールからの import では動かない）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
