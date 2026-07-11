// `npm run check` から実行される、Slack トークンの疎通確認コマンド。
// トークンそのものは絶対に表示しない（接頭辞だけ表示する）。
import { WebClient } from '@slack/web-api';
import { loadAccess, loadTokens, stateDir } from '../src/config.js';
import { errMessage, slackErrorCode } from '../src/errors.js';

/** `xoxb-abc...` → `xoxb-***`（トークン本体は出さない） */
function tokenPrefix(token: string): string {
  const dash = token.indexOf('-');
  if (dash === -1) return '***';
  return `${token.slice(0, dash + 1)}***`;
}

const AUTH_ERROR_HINTS: Record<string, string> = {
  invalid_auth: 'SLACK_BOT_TOKEN が無効。api.slack.com でトークンを確認して',
  missing_scope: 'ボットトークンのスコープが不足している。OAuth & Permissions を確認して',
};

async function main(): Promise<void> {
  const dir = stateDir();
  console.log(`状態ディレクトリ: ${dir}`);

  let tokens;
  try {
    tokens = loadTokens(dir);
  } catch (e) {
    console.error(`[check] トークンの読み込みに失敗: ${errMessage(e)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`SLACK_BOT_TOKEN: ${tokenPrefix(tokens.botToken)}`);
  console.log(`SLACK_APP_TOKEN: ${tokenPrefix(tokens.appToken)}`);

  // access.json は無くても続行する（teamId の突き合わせができないだけ）。
  let access: ReturnType<typeof loadAccess> | undefined;
  try {
    access = loadAccess(dir);
  } catch (e) {
    console.log(`access.json: 未作成、または読み込み不可（${errMessage(e)}）`);
  }

  const client = new WebClient(tokens.botToken);

  let auth;
  try {
    auth = await client.auth.test();
  } catch (e) {
    const code = slackErrorCode(e);
    console.error(`[check] auth.test に失敗: ${code ?? errMessage(e)}`);
    const hint = code ? AUTH_ERROR_HINTS[code] : undefined;
    if (hint) console.error(`  ${hint}`);
    process.exitCode = 1;
    return;
  }

  console.log('--- auth.test ---');
  console.log(`ワークスペース: ${auth.team ?? '(不明)'}`);
  console.log(`team_id: ${auth.team_id ?? '(不明)'}`);
  console.log(`bot user_id: ${auth.user_id ?? '(不明)'}`);

  if (access) {
    // ブリッジ本体（SlackBridge.init）と同じく team_id との完全一致を求める
    if (access.teamId !== auth.team_id) {
      console.warn(
        `[check] 警告: access.json の teamId（${access.teamId}）と auth.test の team_id（${auth.team_id}）が一致しない`
      );
    } else {
      console.log('teamId: access.json と auth.test で一致');
    }

    console.log('--- allowFrom ---');
    for (const userId of access.allowFrom) {
      try {
        const info = await client.users.info({ user: userId });
        const name = info.user?.real_name ?? info.user?.name ?? '(表示名なし)';
        console.log(`${userId}: ${name}`);
      } catch (e) {
        console.log(`${userId}: 表示名の取得に失敗（${errMessage(e)}）`);
      }
    }
  }
}

main().catch((e: unknown) => {
  console.error(`[check] 予期しないエラー: ${errMessage(e)}`);
  process.exitCode = 1;
});
