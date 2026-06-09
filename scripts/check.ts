// `npm run check` から実行される、Slack トークンの疎通確認コマンド。
// トークンそのものは絶対に表示しない（接頭辞だけ表示する）。
import { WebClient } from '@slack/web-api';
import { loadAccess, loadTokens, stateDir } from '../src/config.js';

function tokenPrefix(token: string): string {
  const dash = token.indexOf('-');
  if (dash === -1) return '***';
  return `${token.slice(0, dash + 1)}***`;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// @slack/web-api のプラットフォームエラーは `data.error` に invalid_auth / missing_scope
// などのコード文字列を持つ。それ以外の Error はメッセージだけ表示する。
function platformErrorCode(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'data' in e) {
    const data = (e as { data?: unknown }).data;
    if (typeof data === 'object' && data !== null && 'error' in data) {
      const code = (data as { error?: unknown }).error;
      if (typeof code === 'string') return code;
    }
  }
  return undefined;
}

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
    const code = platformErrorCode(e);
    if (code) {
      console.error(`[check] auth.test に失敗: ${code}`);
      if (code === 'invalid_auth') {
        console.error('  SLACK_BOT_TOKEN が無効。api.slack.com でトークンを確認して');
      } else if (code === 'missing_scope') {
        console.error('  ボットトークンのスコープが不足している。OAuth & Permissions を確認して');
      }
    } else {
      console.error(`[check] auth.test に失敗: ${errMessage(e)}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('--- auth.test ---');
  console.log(`ワークスペース: ${auth.team ?? '(不明)'}`);
  console.log(`team_id: ${auth.team_id ?? '(不明)'}`);
  console.log(`bot user_id: ${auth.user_id ?? '(不明)'}`);

  if (access) {
    if (auth.team_id && access.teamId !== auth.team_id) {
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
