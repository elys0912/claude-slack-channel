// 単発の知らせ（dist/src/notify-cli.js <本文>）。ブリッジが動いていないときに start.ps1 が呼ぶ
// （claude.exe が想定外の終了を繰り返し、起動し直しを諦めたとき。ブリッジは claude.exe と一緒に止まっているので、ほかに知らせる手段が無い）。
// 状態ディレクトリの .env と access.json を読み、許可ユーザー全員の DM に送る。Socket Mode にはつながない。失敗したら exit 1。
import { loadAccess, loadTokens, stateDir } from './config.js';
import { Logger } from './log.js';
import { SlackBridge } from './slack.js';
import type { SlackWebApiLike } from './slack.js';
import { errMessage } from './errors.js';
import { isMainModule } from './main-module.js';

/** 許可ユーザー全員の DM に text を送り、送れた数を返す。web はテスト用（省略時は本物の Web API） */
export async function sendNotice(dir: string, text: string, web?: SlackWebApiLike): Promise<number> {
  const tokens = loadTokens(dir);
  const access = loadAccess(dir);
  const logger = new Logger({ stderr: true });
  const bridge = new SlackBridge({ botToken: tokens.botToken, appToken: tokens.appToken, access, logger, ...(web ? { web } : {}) });
  await bridge.init();
  const sent = await bridge.postToAll(text);
  return sent.length;
}

async function main(): Promise<void> {
  const text = process.argv.slice(2).join(' ').trim();
  if (text === '') {
    process.stderr.write('使い方: node dist/src/notify-cli.js <本文>\n');
    process.exit(1);
  }
  try {
    const count = await sendNotice(stateDir(), text);
    process.exit(count > 0 ? 0 : 1);
  } catch (e) {
    process.stderr.write(`[slackbridge notify] 送れなかった: ${errMessage(e)}\n`);
    process.exit(1);
  }
}

// 直接起動されたときだけ動く（テストや他モジュールからの import では動かない）
if (isMainModule(import.meta.url)) {
  void main();
}
