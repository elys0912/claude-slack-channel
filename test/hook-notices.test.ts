import { describe, expect, it } from 'vitest';
import { hookToNotice } from '../src/hook-notices.js';
import type { HookEvent } from '../src/hook-event.js';

const idle = { waiting: false, pending: 0 };
const waiting = { waiting: true, pending: 0 };

function ev(fields: Partial<HookEvent> & { hook_event_name: string }): HookEvent {
  return { at: 0, ...fields };
}

describe('hookToNotice', () => {
  it.each([
    ['permission_prompt', idle, 'ターミナル側で入力待ち', true],
    ['elicitation_dialog', idle, 'ターミナル側で入力待ち', true],
    ['agent_needs_input', idle, 'ターミナル側で入力待ち', true],
    ['quota_auto_resume_fired', idle, '⏱', false],
  ] as const)('Notification/%s は知らせる', (type, ctx, text, button) => {
    const notice = hookToNotice(ev({ hook_event_name: 'Notification', notification_type: type, message: 'm' }), ctx);
    expect(notice?.text).toContain(text);
    expect(notice?.screenButton).toBe(button);
  });

  it('idle_prompt は Slack の返事待ちなら画面のボタン付きで知らせる', () => {
    const idlePrompt = ev({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'waiting' });
    expect(hookToNotice(idlePrompt, waiting)?.screenButton).toBe(true);
  });

  it('Stop は Slack の返事待ちなら「返事をしないまま」と知らせる', () => {
    expect(hookToNotice(ev({ hook_event_name: 'Stop' }), waiting)?.text).toContain('返事をしないまま');
  });

  // Stop / idle_prompt は Slack の返事待ち（waiting）のときだけ、permission_prompt は中継中（pending）でないときだけ
  it.each([
    ['Stop', undefined, false, 0, false],
    ['Stop', undefined, true, 0, true],
    ['Stop', undefined, true, 1, true],
    ['Notification', 'idle_prompt', false, 0, false],
    ['Notification', 'idle_prompt', true, 0, true],
    ['Notification', 'idle_prompt', true, 1, true],
    ['Notification', 'permission_prompt', false, 0, true],
    ['Notification', 'permission_prompt', true, 0, true],
    ['Notification', 'permission_prompt', false, 1, false],
    ['Notification', 'permission_prompt', true, 1, false],
  ] as const)('%s/%s waiting=%s pending=%s → 知らせる=%s', (name, type, isWaiting, pending, expected) => {
    const event = ev({ hook_event_name: name, ...(type ? { notification_type: type } : {}) });
    const notice = hookToNotice(event, { waiting: isWaiting, pending });
    expect(notice !== undefined).toBe(expected);
    if (notice) expect(notice.screenButton).toBe(true);
  });

  it('auth_success や未知の種類は知らせない', () => {
    expect(hookToNotice(ev({ hook_event_name: 'Notification', notification_type: 'auth_success' }), waiting)).toBeUndefined();
    expect(hookToNotice(ev({ hook_event_name: 'Notification', notification_type: 'something_new' }), waiting)).toBeUndefined();
    expect(hookToNotice(ev({ hook_event_name: 'PreToolUse' }), waiting)).toBeUndefined();
  });

  it('StopFailure は種別ごとの説明にし、詳細があれば添える', () => {
    expect(hookToNotice(ev({ hook_event_name: 'StopFailure', error: 'rate_limit', error_details: 'resets at 15:00' }), idle)?.text).toBe(
      '⛔ 使用量の上限（rate limit）に達した。上限が戻るまで応答できない\nresets at 15:00'
    );
  });

  it.each([
    ['未知の種別ならその名前', 'weird', 'weird'],
    ['種別が無ければ unknown', undefined, 'unknown'],
  ] as const)('StopFailure は%sを出す', (_label, error, expected) => {
    const event = ev({ hook_event_name: 'StopFailure', ...(error ? { error } : {}) });
    expect(hookToNotice(event, idle)?.text).toContain(expected);
  });

  describe('セッションの開始・終了・クリア・圧縮を知らせる', () => {
    it.each([
      ['SessionStart(startup)', { hook_event_name: 'SessionStart', source: 'startup', cwd: 'C:\\dev' }, '🟢 Claude Code のセッションを開始した: C:\\dev'],
      ['SessionStart(resume)', { hook_event_name: 'SessionStart', source: 'resume' }, expect.stringContaining('開始した')],
      ['SessionStart(clear)', { hook_event_name: 'SessionStart', source: 'clear' }, expect.stringContaining('クリア')],
      ['SessionEnd(logout)', { hook_event_name: 'SessionEnd', reason: 'logout' }, expect.stringContaining('終了した（logout）')],
      ['PostCompact(auto)', { hook_event_name: 'PostCompact', trigger: 'auto' }, expect.stringContaining('自動で圧縮')],
      ['PostCompact(manual)', { hook_event_name: 'PostCompact', trigger: 'manual' }, '🧹 会話を圧縮した'],
    ])('%s', (_label, fields, expected) => {
      expect(hookToNotice(ev(fields), idle)?.text).toEqual(expected);
    });

    it.each([
      // compact による SessionStart は PostCompact に任せる
      ['SessionStart(compact)', { hook_event_name: 'SessionStart', source: 'compact' }],
      // /clear の終了は、続く SessionStart（source=clear）の「会話をクリアした」だけにする
      ['SessionEnd(clear)', { hook_event_name: 'SessionEnd', reason: 'clear' }],
    ])('%s は知らせない', (_label, fields) => {
      expect(hookToNotice(ev(fields), idle)).toBeUndefined();
    });
  });
});
