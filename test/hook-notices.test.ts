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

  it('permission_prompt は Slack に中継中（pending）なら黙る', () => {
    expect(hookToNotice(ev({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }), { waiting: true, pending: 1 })).toBeUndefined();
  });

  it('idle_prompt と Stop は Slack に返事が無いときだけ知らせる', () => {
    const idlePrompt = ev({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'waiting' });
    expect(hookToNotice(idlePrompt, idle)).toBeUndefined();
    expect(hookToNotice(idlePrompt, waiting)?.screenButton).toBe(true);
    const stop = ev({ hook_event_name: 'Stop' });
    expect(hookToNotice(stop, idle)).toBeUndefined();
    expect(hookToNotice(stop, waiting)?.text).toContain('返事をしないまま');
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
    expect(hookToNotice(ev({ hook_event_name: 'StopFailure', error: 'weird' }), idle)?.text).toContain('weird');
    expect(hookToNotice(ev({ hook_event_name: 'StopFailure' }), idle)?.text).toContain('unknown');
  });

  it('セッションの開始・終了・クリア・圧縮を知らせる（compact による SessionStart は PostCompact に任せる）', () => {
    expect(hookToNotice(ev({ hook_event_name: 'SessionStart', source: 'startup', cwd: 'C:\\dev' }), idle)?.text).toBe('🟢 Claude Code のセッションを開始した: C:\\dev');
    expect(hookToNotice(ev({ hook_event_name: 'SessionStart', source: 'resume' }), idle)?.text).toContain('開始した');
    expect(hookToNotice(ev({ hook_event_name: 'SessionStart', source: 'clear' }), idle)?.text).toContain('クリア');
    expect(hookToNotice(ev({ hook_event_name: 'SessionStart', source: 'compact' }), idle)).toBeUndefined();
    expect(hookToNotice(ev({ hook_event_name: 'SessionEnd', reason: 'logout' }), idle)?.text).toContain('終了した（logout）');
    // /clear の終了は、続く SessionStart（source=clear）の「会話をクリアした」だけにする
    expect(hookToNotice(ev({ hook_event_name: 'SessionEnd', reason: 'clear' }), idle)).toBeUndefined();
    expect(hookToNotice(ev({ hook_event_name: 'PostCompact', trigger: 'auto' }), idle)?.text).toContain('自動で圧縮');
    expect(hookToNotice(ev({ hook_event_name: 'PostCompact', trigger: 'manual' }), idle)?.text).toBe('🧹 会話を圧縮した');
  });
});
