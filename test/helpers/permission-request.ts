// 許可判定のテストで使う、実行許可のリクエストとホームフォルダー。
// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。
import type { PermissionRequest } from '../../src/permission-core.js';

/** ホームフォルダーの代わり（Windows の形。実在しなくてよい） */
export const HOME = 'C:\\Users\\me';

/** tool の実行許可のリクエスト。input が文字列ならそのまま input_preview にする（省略された JSON を作るとき） */
export function req(tool: string, input: unknown): PermissionRequest {
  return {
    request_id: 'abcde',
    tool_name: tool,
    description: '',
    input_preview: typeof input === 'string' ? input : JSON.stringify(input),
  };
}
