// @slack/web-api のエラーの判定（I/O なし）。errors.ts は discord と同じ内容にしているので、Slack 固有のものはこちらに置く

/**
 * @slack/web-api のプラットフォームエラーから `data.error` のコード
 * （invalid_auth / missing_scope など）を取り出す。該当しなければ undefined。
 */
export function slackErrorCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const data = (e as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const code = (data as { error?: unknown }).error;
  return typeof code === 'string' ? code : undefined;
}
