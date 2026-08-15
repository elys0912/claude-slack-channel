// `!status` の文面（純関数）
import { MS_PER_MINUTE, formatTime } from './text.js';
import type { HookEvent } from './hook-event.js';

export interface StatusState {
  startedAt: Date;
  workDir: string;
  slackConnected: boolean | undefined;
  /** Claude への返事を待ち始めた時刻。待っていなければ undefined */
  waitingSince: Date | undefined;
  /** 回答待ちの実行許可の件数 */
  pendingPermissions: number;
  /** 直近の hook（古い順） */
  lastHooks: HookEvent[];
  /** 「全部許可」。機能が無ければ undefined、無効なら null、有効なら開始時刻 */
  sessionAllowSince?: Date | null | undefined;
  /** チャネル固有の行（全部許可の後に足す）。無ければ足さない */
  extraLines?: string[] | undefined;
  now: Date;
}

function elapsed(from: Date, to: Date): string {
  const minutes = Math.max(0, Math.round((to.getTime() - from.getTime()) / MS_PER_MINUTE));
  return minutes < 60 ? `${minutes} 分` : `${Math.floor(minutes / 60)} 時間 ${minutes % 60} 分`;
}

function hookLine(event: HookEvent): string {
  const kind = event.notification_type ? `${event.hook_event_name}/${event.notification_type}` : event.hook_event_name;
  const detail = event.error ?? event.source ?? event.reason ?? event.trigger;
  return `${formatTime(new Date(event.at))} ${kind}${detail ? ` (${detail})` : ''}`;
}

function connectionLabel(connected: boolean | undefined): string {
  if (connected === undefined) return '(不明)';
  return connected ? '接続中' : '切断中（再接続待ち）';
}

/** 「全部許可」の行。機能が無ければ（undefined）行を出さない */
function sessionAllowLines(since: Date | null | undefined): string[] {
  if (since === undefined) return [];
  if (since === null) return ['全部許可: 無効'];
  return [`全部許可: 有効（${formatTime(since)} から。!lock で解除）`];
}

export function buildStatusText(state: StatusState): string {
  const lines = [
    '📊 ブリッジの状態',
    `稼働開始: ${formatTime(state.startedAt)}（${elapsed(state.startedAt, state.now)} 経過）`,
    `作業フォルダー: ${state.workDir || '(不明)'}`,
    `Slack 接続: ${connectionLabel(state.slackConnected)}`,
    `Claude への返事待ち: ${state.waitingSince ? `${formatTime(state.waitingSince)} から（${elapsed(state.waitingSince, state.now)}）` : '無し'}`,
    `回答待ちの実行許可: ${state.pendingPermissions} 件`,
    ...sessionAllowLines(state.sessionAllowSince),
    ...(state.extraLines ?? []),
    state.lastHooks.length > 0 ? `直近の hook:\n${state.lastHooks.map((e) => `  ${hookLine(e)}`).join('\n')}` : '直近の hook: 無し',
  ];
  return lines.join('\n');
}
