import { describe, expect, it } from 'vitest';
import {
  PendingPermissions,
  PERMISSION_ID_BODY,
  PERMISSION_ID_RE,
  isValidRequestId,
  buildPermissionBlocks,
  buildResolvedBlocks,
  buildExpiredBlocks,
  parseBlockAction,
  type PermissionRequest
} from '../src/permission.js';
import type { ParsedAccess } from '../src/config.js';

const access: ParsedAccess = { teamId: 'T123', allowFrom: ['U123'] };

const sampleReq: PermissionRequest = {
  request_id: 'abcde',
  tool_name: 'Write',
  description: 'Create hello.txt',
  input_preview: 'contents of hello.txt'
};

describe('PERMISSION_ID_RE / isValidRequestId', () => {
  it('accepts 5 lowercase letters excluding l', () => {
    expect(isValidRequestId('abcde')).toBe(true);
    expect(PERMISSION_ID_RE.test('zzzzz')).toBe(true);
  });

  it('rejects ids containing l', () => {
    expect(isValidRequestId('abcle')).toBe(false);
    expect(isValidRequestId('lbcde')).toBe(false);
  });

  it('rejects uppercase letters', () => {
    expect(isValidRequestId('ABCDE')).toBe(false);
  });

  it('rejects wrong lengths', () => {
    expect(isValidRequestId('abcd')).toBe(false);
    expect(isValidRequestId('abcdef')).toBe(false);
  });

  it('PERMISSION_ID_RE は PERMISSION_ID_BODY を前後アンカーで包んだもの', () => {
    expect(PERMISSION_ID_RE.source).toBe(`^${PERMISSION_ID_BODY}$`);
    expect(PERMISSION_ID_RE.flags).toBe('');
  });
});

describe('PendingPermissions', () => {
  it('returns the request via get() before expiry', () => {
    let now = 1000;
    const pending = new PendingPermissions(1000, () => now);
    pending.add(sampleReq);
    expect(pending.get('abcde')).toEqual(sampleReq);
  });

  it('expires after ttlMs and get() returns undefined', () => {
    let now = 1000;
    const pending = new PendingPermissions(1000, () => now);
    pending.add(sampleReq);
    now = 2001; // ttl 経過
    expect(pending.get('abcde')).toBeUndefined();
  });

  it('take() removes the entry so a second take() is undefined', () => {
    let now = 1000;
    const pending = new PendingPermissions(1000, () => now);
    pending.add(sampleReq);
    expect(pending.take('abcde')).toEqual(sampleReq);
    expect(pending.take('abcde')).toBeUndefined();
  });

  it('take() returns undefined for an expired entry', () => {
    let now = 1000;
    const pending = new PendingPermissions(1000, () => now);
    pending.add(sampleReq);
    now = 5000;
    expect(pending.take('abcde')).toBeUndefined();
  });

  it('prune() removes expired entries so a later get() at the same time is still undefined', () => {
    let now = 1000;
    const pending = new PendingPermissions(1000, () => now);
    pending.add(sampleReq);
    now = 5000;
    pending.prune();
    expect(pending.get('abcde')).toBeUndefined();
  });
});

describe('buildPermissionBlocks', () => {
  it('produces plain_text header/section blocks', () => {
    const { text, blocks, truncated } = buildPermissionBlocks(sampleReq);
    expect(truncated).toBe(false);
    expect(text).toContain('Write');
    const header = blocks[0] as { type: string; text: { type: string; text: string } };
    expect(header.type).toBe('header');
    expect(header.text.type).toBe('plain_text');
    const section = blocks[1] as { type: string; text: { type: string } };
    expect(section.type).toBe('section');
    expect(section.text.type).toBe('plain_text');
  });

  it('truncates a long input_preview and sets truncated=true, adding a See more button', () => {
    const longReq: PermissionRequest = { ...sampleReq, input_preview: 'x'.repeat(5000) };
    const { blocks, truncated } = buildPermissionBlocks(longReq, 100);
    expect(truncated).toBe(true);
    const preformatted = blocks.find(
      (b): b is { type: string; elements: unknown[] } => (b as { type: string }).type === 'rich_text'
    ) as { elements: { elements: { text: string }[] }[] };
    const previewText = preformatted.elements[0]?.elements[0]?.text ?? '';
    expect(previewText.length).toBeLessThanOrEqual(100);
    expect(previewText.endsWith('…')).toBe(true);

    const actions = blocks.find((b) => (b as { type: string }).type === 'actions') as { elements: { action_id: string }[] };
    expect(actions.elements.some((e) => e.action_id === 'perm_more')).toBe(true);
  });

  it('does not add a See more button when nothing is truncated', () => {
    const { blocks } = buildPermissionBlocks(sampleReq);
    const actions = blocks.find((b) => (b as { type: string }).type === 'actions') as { elements: { action_id: string }[] };
    expect(actions.elements.some((e) => e.action_id === 'perm_more')).toBe(false);
  });

  it('sets action_id and value correctly on Allow/Deny buttons', () => {
    const { blocks } = buildPermissionBlocks(sampleReq);
    const actions = blocks.find((b) => (b as { type: string }).type === 'actions') as {
      elements: { action_id: string; value: string; style?: string }[];
    };
    const allow = actions.elements.find((e) => e.action_id === 'perm_allow');
    const deny = actions.elements.find((e) => e.action_id === 'perm_deny');
    expect(allow?.value).toBe('abcde');
    expect(allow?.style).toBe('primary');
    expect(deny?.value).toBe('abcde');
    expect(deny?.style).toBe('danger');
  });

  it('keeps plain_text fields within the 3000 char Slack limit', () => {
    const hugeReq: PermissionRequest = {
      request_id: 'abcde',
      tool_name: 'T'.repeat(4000),
      description: 'D'.repeat(4000),
      input_preview: 'P'.repeat(4000)
    };
    const { blocks } = buildPermissionBlocks(hugeReq);
    for (const b of blocks) {
      const block = b as { type: string; text?: { type: string; text: string } };
      if (block.type === 'section' && block.text?.type === 'plain_text') {
        expect(block.text.text.length).toBeLessThanOrEqual(3000);
      }
    }
  });
});

describe('buildResolvedBlocks', () => {
  it('reflects allow', () => {
    const { text } = buildResolvedBlocks(sampleReq, 'allow', 'U123');
    expect(text).toContain('Allowed');
  });

  it('reflects deny', () => {
    const { text } = buildResolvedBlocks(sampleReq, 'deny', 'U123');
    expect(text).toContain('Denied');
  });
});

describe('buildExpiredBlocks', () => {
  it('mentions the request id and expiry', () => {
    const { text } = buildExpiredBlocks('abcde');
    expect(text).toContain('abcde');
    expect(text).toContain('expired');
  });
});

describe('parseBlockAction', () => {
  const allowedChannels = new Set(['D1']);
  const validInput = {
    type: 'block_actions',
    teamId: 'T123',
    userId: 'U123',
    channelId: 'D1',
    actionId: 'perm_allow',
    value: 'abcde'
  };

  it('parses a valid Allow action', () => {
    const result = parseBlockAction(validInput, access, allowedChannels);
    expect(result).toEqual({ ok: true, kind: 'verdict', verdict: { requestId: 'abcde', behavior: 'allow' } });
  });

  it('parses a valid Deny action', () => {
    const result = parseBlockAction({ ...validInput, actionId: 'perm_deny' }, access, allowedChannels);
    expect(result).toEqual({ ok: true, kind: 'verdict', verdict: { requestId: 'abcde', behavior: 'deny' } });
  });

  it('parses a valid See more action', () => {
    const result = parseBlockAction({ ...validInput, actionId: 'perm_more' }, access, allowedChannels);
    expect(result).toEqual({ ok: true, kind: 'see_more', requestId: 'abcde' });
  });

  it('rejects a non block_actions type', () => {
    const result = parseBlockAction({ ...validInput, type: 'view_submission' }, access, allowedChannels);
    expect(result).toEqual({ ok: false, reason: 'not_block_actions' });
  });

  it('rejects a team mismatch', () => {
    const result = parseBlockAction({ ...validInput, teamId: 'TOTHER' }, access, allowedChannels);
    expect(result.ok).toBe(false);
  });

  it('rejects a user not in allowFrom', () => {
    const result = parseBlockAction({ ...validInput, userId: 'UNKNOWN' }, access, allowedChannels);
    expect(result.ok).toBe(false);
  });

  it('rejects a channel not in allowedDmChannels', () => {
    const result = parseBlockAction({ ...validInput, channelId: 'DOTHER' }, access, allowedChannels);
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid request id (contains l)', () => {
    const result = parseBlockAction({ ...validInput, value: 'abcdl' }, access, allowedChannels);
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown action_id', () => {
    const result = parseBlockAction({ ...validInput, actionId: 'perm_unknown' }, access, allowedChannels);
    expect(result).toEqual({ ok: false, reason: 'unknown_action' });
  });
});
