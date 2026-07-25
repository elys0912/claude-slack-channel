// @slack/logger 互換のアダプタ（SocketModeClient / WebClient の logger オプションに渡す）。
import type { Logger as SlackLogger, LogLevel as SlackLogLevel } from '@slack/logger';
import type { Logger } from './log.js';

/**
 * @slack/logger の Logger インターフェース互換のアダプタ。
 * SocketModeClient / WebClient の logger オプションにそのまま渡せる形。
 *
 * Logger はプロセスで 1 つを共有しているので、SDK からの setName / setLevel は共有側に透過させない
 * （WebClient はコンストラクタで setLevel(INFO) を呼ぶ）。代わりに行頭へ範囲名 `[scope]` を付ける。
 * @slack/logger の LogLevel（文字列 enum）は値が 'debug' | 'info' | 'warn' | 'error' で
 * このモジュールの LogLevel と同じなので、getLevel は enum 型として返す。
 */
export function toSlackLogger(l: Logger, scope: string): SlackLogger {
  const tag = `[${scope}]`;
  return {
    debug: (...m: unknown[]) => l.debug(tag, ...m),
    info: (...m: unknown[]) => l.info(tag, ...m),
    warn: (...m: unknown[]) => l.warn(tag, ...m),
    error: (...m: unknown[]) => l.error(tag, ...m),
    setLevel: () => undefined,
    getLevel: (): SlackLogLevel => l.getLevel() as SlackLogLevel,
    setName: () => undefined,
  };
}
