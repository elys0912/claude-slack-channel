// エラー値を表示・判定用の文字列に変換する helper（I/O なし）

/** 例外を表示用のメッセージにする（Error 以外が投げられても文字列にする） */
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
