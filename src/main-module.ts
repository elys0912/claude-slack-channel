// コマンドとして直接起動された（node dist/src/<名前>.js）かの判定。
// hook・statusline などの入口のファイルが、テストや他モジュールからの import では main を動かさないために使う。
// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
import { pathToFileURL } from 'node:url';

/** metaUrl（呼び出し側の import.meta.url）のファイルが、node に直接渡されたスクリプトか */
export function isMainModule(metaUrl: string): boolean {
  const scriptPath = process.argv[1];
  return scriptPath !== undefined && metaUrl === pathToFileURL(scriptPath).href;
}
