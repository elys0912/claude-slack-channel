import { describe, expect, it } from 'vitest';
import { buildStatusText, type StatusState } from '../src/status.js';

const now = new Date(2026, 9, 1, 10, 30);

describe('buildStatusText', () => {
  // 起動した直後で、何も待っていない状態。各テストは変える項目だけを上書きする
  const base: StatusState = { startedAt: now, workDir: '', slackConnected: true, waitingSince: undefined, pendingPermissions: 0, lastHooks: [], now };

  it('稼働時間・作業フォルダー・接続・返事待ち・許可件数・直近の hook を出す', () => {
    const text = buildStatusText({
      ...base,
      startedAt: new Date(2026, 9, 1, 9, 0),
      workDir: 'C:\\dev\\app',
      waitingSince: new Date(2026, 9, 1, 10, 25),
      pendingPermissions: 2,
      lastHooks: [
        { at: new Date(2026, 9, 1, 10, 20).getTime(), hook_event_name: 'Notification', notification_type: 'permission_prompt' },
        { at: new Date(2026, 9, 1, 10, 21).getTime(), hook_event_name: 'StopFailure', error: 'rate_limit' },
      ],
    });
    expect(text).toContain('稼働開始: 2026-10-01 09:00（1 時間 30 分 経過）');
    expect(text).toContain('作業フォルダー: C:\\dev\\app');
    expect(text).toContain('Slack 接続: 接続中');
    expect(text).toContain('返事待ち: 2026-10-01 10:25 から（5 分）');
    expect(text).toContain('回答待ちの実行許可: 2 件');
    expect(text).toContain('10:20 Notification/permission_prompt');
    expect(text).toContain('10:21 StopFailure (rate_limit)');
  });

  it('待っていない・hook 無し・接続不明も書ける', () => {
    const text = buildStatusText({ ...base, slackConnected: undefined });
    expect(text).toContain('（0 分 経過）');
    expect(text).toContain('作業フォルダー: (不明)');
    expect(text).toContain('Slack 接続: (不明)');
    expect(text).toContain('返事待ち: 無し');
    expect(text).toContain('直近の hook: 無し');
  });

  it('チャネル固有の行（extraLines）を全部許可の後、hook の前に足す', () => {
    const lines = buildStatusText({ ...base, sessionAllowSince: null, extraLines: ['追加の行'] }).split('\n');
    expect(lines.indexOf('追加の行')).toBe(lines.indexOf('全部許可: 無効') + 1);
    expect(buildStatusText(base)).toBe(buildStatusText({ ...base, extraLines: [] }));
  });
});
