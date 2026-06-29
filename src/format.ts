// Slack への送信前にテキストを安全な形へ整える純関数群（I/O なし）

const BROADCAST_TAG_RE = /<!(channel|here|everyone)>/g;
const SUBTEAM_TAG_RE = /<!subteam\^([A-Za-z0-9]+)(\|[^>]*)?>/g;
const BARE_BROADCAST_RE = /@(channel|here|everyone)\b/g;

/**
 * `<!channel>` `<!here>` `<!everyone>` `<!subteam^ID>` と、素の `@channel` 等の
 * 一斉メンションを、ゼロ幅スペースを挟んで無効化する。
 */
export function neutralizeBroadcasts(text: string): string {
  let result = text;
  result = result.replace(BROADCAST_TAG_RE, (_m, kind: string) => `@​${kind}`);
  result = result.replace(SUBTEAM_TAG_RE, (_m, id: string) => `@​subteam:${id}`);
  result = result.replace(BARE_BROADCAST_RE, (_m, kind: string) => `@​${kind}`);
  return result;
}

/** mrkdwn の text フィールド用フォールバックエスケープ（& < > のみ） */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const META_KEY_RE = /^[A-Za-z0-9_]+$/;
/** meta の値 1 つあたりの上限（添付が大量・長いファイル名でも Claude に渡すタグを膨らませない） */
export const META_VALUE_MAX = 2000;

/**
 * meta のキー・値ルールを適用する（キーは英数字とアンダースコアのみ、値は undefined 除外、
 * 値は META_VALUE_MAX 文字まで。超えた分は切り捨てて末尾を … にする）
 */
export function sanitizeMeta(meta: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    if (!META_KEY_RE.test(key)) continue;
    out[key] = value.length > META_VALUE_MAX ? value.slice(0, META_VALUE_MAX - 1) + '…' : value;
  }
  return out;
}
