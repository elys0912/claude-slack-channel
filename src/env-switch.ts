// .env の on / off の値の読み方（I/O なし）。
// このファイルは claude-slack-channel と claude-discord-channel で同じ内容にしている（直すときは両方を直す）。

/** on / true / 1 なら true、off / false / 0 なら false（大文字・小文字と前後の空白は問わない）、空・未設定なら undefined、それ以外は null */
export function parseSwitch(raw: string | undefined): boolean | null | undefined {
  const value = (raw ?? '').trim();
  if (value === '') return undefined;
  if (/^(on|true|1)$/i.test(value)) return true;
  if (/^(off|false|0)$/i.test(value)) return false;
  return null;
}

/** 知らない値のときの知らせの文（値はそのまま出さず、長さだけ。トークンの書き間違いを出さないため） */
export function unknownSwitchMessage(key: string, raw: string, fallback: boolean): string {
  return `.env の ${key} の値（${raw.trim().length} 文字）は on / off のどちらでもないので ${fallback ? 'on' : 'off'} にした`;
}
