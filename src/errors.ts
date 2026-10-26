// エラー値を表示・判定用の文字列に変換する helper（I/O なし）

/** 例外を表示用のメッセージにする（Error 以外が投げられても文字列にする） */
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
