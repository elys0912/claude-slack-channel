// Slack への送信前にテキストを安全な形へ整える純関数群（I/O なし）
import { clip } from './text.js';

/** `<!here>` と、ラベル付きの `<!here|here>`（どちらも一斉メンションになる） */
const BROADCAST_TAG_RE = /<!(channel|here|everyone)(?:\|[^>]*)?>/g;
const SUBTEAM_TAG_RE = /<!subteam\^([A-Za-z0-9]+)(\|[^>]*)?>/g;
const BARE_BROADCAST_RE = /@(channel|here|everyone)\b/g;
/** ゼロ幅スペース。`@` と語の間に挟んでメンションとして解釈されないようにする */
const ZWSP = '\u200b';

/**
 * `<!channel>` `<!here>` `<!everyone>` `<!subteam^ID>` と、素の `@channel` 等の
 * 一斉メンションを、ゼロ幅スペースを挟んで無効化する。
 */
export function neutralizeBroadcasts(text: string): string {
  return text
    .replace(BROADCAST_TAG_RE, (_m, kind: string) => `@${ZWSP}${kind}`)
    .replace(SUBTEAM_TAG_RE, (_m, id: string) => `@${ZWSP}subteam:${id}`)
    .replace(BARE_BROADCAST_RE, (_m, kind: string) => `@${ZWSP}${kind}`);
}

/** mrkdwn の text フィールド用フォールバックエスケープ（& < > のみ） */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * markdown_text で触らない範囲（フェンスのコード・インラインコード・`[文字](URL)`）と、書き換える対象
 * （mrkdwn の `<URL>` / `<URL|文字>`、生の URL）。生の URL は ASCII の URL に使える文字だけで切るので、
 * 「：https://…」や「…）」のように全角の文字が続いても、そこで止まる。括弧は含めない
 */
const MARKDOWN_LINK_TOKEN_RE =
  /(```[\s\S]*?(?:```|$)|`[^`\n]*`|\[[^\]\n]*\]\([^)\s]*\))|<(https?:\/\/[^\s<>|]+)(?:\|([^<>\n]*))?>|(https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'*+,;=%]+)/g;
/** URL の末尾に付いていても URL の一部とはみなさない記号（文末の句読点など） */
const URL_TRAILING_PUNCT_RE = /[.,;:!?'*]+$/;
/** markdown のリンクの文字で、書式として読まれる記号 */
const MARKDOWN_LABEL_SPECIAL_RE = /[\\`*_~[\]]/g;

function markdownLink(url: string, label: string): string {
  return `[${label.replace(MARKDOWN_LABEL_SPECIAL_RE, '\\$&')}](${url})`;
}

/**
 * markdown_text 用に、URL を `[URL](URL)` の形にする。Slack の markdown_text は `[文字](URL)` しかリンクにせず、
 * 生の URL や mrkdwn の `<URL|文字>` はそのまま文字で出るため。コードの中と、もう `[文字](URL)` のものは触らない
 */
export function linkifyMarkdownUrls(text: string): string {
  return text.replace(
    MARKDOWN_LINK_TOKEN_RE,
    (whole, kept: string | undefined, angleUrl: string | undefined, angleLabel: string | undefined, bare: string | undefined) => {
      if (kept !== undefined) return kept;
      if (angleUrl !== undefined) return markdownLink(angleUrl, angleLabel?.trim() || angleUrl);
      if (bare === undefined) return whole;
      const trailing = URL_TRAILING_PUNCT_RE.exec(bare)?.[0] ?? '';
      const url = bare.slice(0, bare.length - trailing.length);
      // `https://` だけのような中身の無いものはリンクにしない
      if (!/^https?:\/\/[^/]/.test(url)) return whole;
      return markdownLink(url, url) + trailing;
    },
  );
}

const META_KEY_RE = /^[A-Za-z0-9_]+$/;
/** meta の値 1 つあたりの上限（添付が大量・長いファイル名でも Claude に渡すタグを膨らませない） */
export const META_VALUE_MAX = 2000;

/**
 * meta のキー・値ルールを適用する（キーは英数字とアンダースコアのみ、値は undefined 除外、
 * 値は META_VALUE_MAX 文字まで。超えた分は切り捨てて末尾を … にする。サロゲートペアの途中では切らない）
 */
export function sanitizeMeta(meta: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    if (!META_KEY_RE.test(key)) continue;
    out[key] = clip(value, META_VALUE_MAX);
  }
  return out;
}
