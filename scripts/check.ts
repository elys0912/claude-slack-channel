// `npm run check` から実行される、Slack トークンの疎通確認コマンド。
// トークンそのものは絶対に表示しない（接頭辞だけ表示する）。
import { WebClient } from '@slack/web-api';
import { loadAccess, loadTokens, stateDir } from '../src/config.js';
import { errMessage } from '../src/errors.js';
import { slackErrorCode } from '../src/slack-errors.js';

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

const APP_TOKEN_ERROR_HINTS: Record<string, string> = {
  invalid_auth: 'SLACK_APP_TOKEN が無効（Revoke した古いトークンなど）。Basic Information → App-Level Tokens で発行し直して',
  not_allowed_token_type: 'SLACK_APP_TOKEN に App-Level Token（xapp-）でないトークンが入っている',
  missing_scope: 'App-Level Token に connections:write のスコープが無い。発行し直すときにスコープを付けて',
};

/** Slack API の失敗の code（無ければ例外の文）を出し、hints に対処があれば続けて出す */
function reportSlackError(api: string, e: unknown, hints: Record<string, string>): void {
  const code = slackErrorCode(e);
  console.error(`[check] ${api} に失敗: ${code ?? errMessage(e)}`);
  const hint = code ? hints[code] : undefined;
  if (hint) console.error(`  ${hint}`);
}

/**
 * App-Level Token（Socket Mode の接続に使う）が有効か。接続の URL を取れるかだけを見て、接続はしない（URL も表示しない）。
 * 失敗したら理由を出して false
 */
async function checkAppToken(appToken: string): Promise<boolean> {
  try {
    await new WebClient(appToken).apps.connections.open();
    console.log('SLACK_APP_TOKEN: apps.connections.open OK（Socket Mode に接続できる）');
    return true;
  } catch (e) {
    reportSlackError('apps.connections.open', e, APP_TOKEN_ERROR_HINTS);
    return false;
  }
}

/** ブリッジ本体（SlackBridge.init）と同じく、access.json の teamId と auth.test の team_id の完全一致を求める。一致しなくても警告だけ */
function checkTeamId(accessTeamId: string, authTeamId: string | undefined): void {
  if (accessTeamId !== authTeamId) {
    console.warn(`[check] 警告: access.json の teamId（${accessTeamId}）と auth.test の team_id（${authTeamId}）が一致しない`);
  } else {
    console.log('teamId: access.json と auth.test で一致');
  }
}

/** allowFrom の各ユーザーの表示名を出す。取れなかったユーザーは理由を出して続ける */
async function printAllowFrom(client: WebClient, allowFrom: readonly string[]): Promise<void> {
  console.log('--- allowFrom ---');
  for (const userId of allowFrom) {
    try {
      const info = await client.users.info({ user: userId });
      const name = info.user?.real_name ?? info.user?.name ?? '(表示名なし)';
      console.log(`${userId}: ${name}`);
    } catch (e) {
      console.log(`${userId}: 表示名の取得に失敗（${errMessage(e)}）`);
    }
  }
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
    reportSlackError('auth.test', e, AUTH_ERROR_HINTS);
    process.exitCode = 1;
    return;
  }

  console.log('--- auth.test ---');
  console.log(`ワークスペース: ${auth.team ?? '(不明)'}`);
  console.log(`team_id: ${auth.team_id ?? '(不明)'}`);
  console.log(`bot user_id: ${auth.user_id ?? '(不明)'}`);

  // ボットトークンが通っても、App-Level Token が無効なら起動時に Socket Mode の開始で失敗する
  if (!(await checkAppToken(tokens.appToken))) process.exitCode = 1;

  if (access) {
    checkTeamId(access.teamId, auth.team_id);
    await printAllowFrom(client, access.allowFrom);
  }
}

main().catch((e: unknown) => {
  console.error(`[check] 予期しないエラー: ${errMessage(e)}`);
  process.exitCode = 1;
});
