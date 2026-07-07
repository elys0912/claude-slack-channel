import { describe, expect, it } from 'vitest';
import {
  PendingPermissions,
  PERMISSION_ID_BODY,
  PERMISSION_ID_RE,
  isValidRequestId,
  buildPermissionBlocks,
  buildResolvedBlocks,
  buildExpiredBlocks,
  buildAutoDeniedBlocks,
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
    expect(previewText).toContain('文字省略');

    const actions = blocks.find((b) => (b as { type: string }).type === 'actions') as { elements: { action_id: string }[] };
    expect(actions.elements.some((e) => e.action_id === 'perm_more')).toBe(true);
  });

  function previewOf(blocks: unknown[]): string {
    const rich = blocks.find((b) => (b as { type: string }).type === 'rich_text') as {
      elements: { elements: { text: string }[] }[];
    };
    return rich.elements[0]?.elements[0]?.text ?? '';
  }

  it('長い input_preview は先頭と末尾を残し、省略した文字数を間に入れる（既定で先頭約 2000 + 末尾約 600）', () => {
    const preview = 'H'.repeat(3000) + 'M'.repeat(3000) + 'T'.repeat(3000);
    const { blocks } = buildPermissionBlocks({ ...sampleReq, input_preview: preview });
    const text = previewOf(blocks);
    expect(text.length).toBeLessThanOrEqual(2800);
    const m = /^(H+)\n…（途中 (\d+) 文字省略）…\n(T+)$/.exec(text);
    expect(m).not.toBeNull();
    const [, head = '', omitted = '0', tail = ''] = m ?? [];
    expect(head.length).toBeGreaterThanOrEqual(2000);
    expect(tail.length).toBeGreaterThanOrEqual(550);
    expect(head.length + Number(omitted) + tail.length).toBe(preview.length);
  });

  it('input_preview を省略したときだけ警告行（context）を preview の直後に足す', () => {
    const long = buildPermissionBlocks({ ...sampleReq, input_preview: 'x'.repeat(5000) });
    const types = long.blocks.map((b) => (b as { type: string }).type);
    expect(types).toEqual(['header', 'section', 'section', 'rich_text', 'context', 'context', 'actions']);
    expect(JSON.stringify(long.blocks[4])).toContain('See more');

    const short = buildPermissionBlocks(sampleReq);
    expect(short.blocks.map((b) => (b as { type: string }).type)).toEqual([
      'header',
      'section',
      'section',
      'rich_text',
      'context',
      'actions'
    ]);
  });

  it('双方向制御文字・ゼロ幅文字・BOM を \\u{XXXX} の形で見えるようにする', () => {
    const invisible = '‪‫‬‭‮⁦⁧⁨⁩​‌‍﻿';
    const { blocks } = buildPermissionBlocks({
      ...sampleReq,
      description: `desc‮gnp.exe`,
      input_preview: `rm${invisible}x`
    });
    expect(previewOf(blocks)).toBe(
      'rm\\u{202A}\\u{202B}\\u{202C}\\u{202D}\\u{202E}\\u{2066}\\u{2067}\\u{2068}\\u{2069}\\u{200B}\\u{200C}\\u{200D}\\u{FEFF}x'
    );
    expect(JSON.stringify(blocks)).not.toMatch(/[‪-‮⁦-⁩​-‍﻿]/);
    expect((blocks[2] as { text: { text: string } }).text.text).toBe('desc\\u{202E}gnp.exe');
  });

  it('切り詰めの境目でサロゲートペアや可視化したエスケープを割らない', () => {
    const preview = ('😀‮').repeat(2000);
    const { blocks } = buildPermissionBlocks({ ...sampleReq, input_preview: preview }, 101);
    const text = previewOf(blocks);
    expect(text.length).toBeLessThanOrEqual(101);
    const [head = '', tail = ''] = text.split(/\n…（途中 \d+ 文字省略）…\n/);
    expect(head).toMatch(/^(😀\\u\{202E\}|😀)*$/);
    expect(tail).toMatch(/^(\\u\{202E\}|😀)*$/);
    expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
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

describe('空の項目', () => {
  function texts(blocks: unknown[]): string[] {
    const out: string[] = [];
    for (const b of blocks) {
      const block = b as { type: string; text?: { text: string }; elements?: { elements?: { text: string }[] }[] };
      if (block.type === 'section' && block.text) out.push(block.text.text);
      if (block.type === 'rich_text') out.push(block.elements?.[0]?.elements?.[0]?.text ?? '');
    }
    return out;
  }

  it.each(['', '   ', '\n'])('tool_name / description / input_preview が空（%j）でも空の text を出さない', (empty) => {
    const req: PermissionRequest = { request_id: 'abcde', tool_name: empty, description: empty, input_preview: empty };
    const { blocks } = buildPermissionBlocks(req);
    expect(texts(blocks)).toEqual(['Tool: (不明なツール)', '(説明なし)', '(入力なし)']);

    const resolved = buildResolvedBlocks(req, 'allow', 'U123');
    expect(texts(resolved.blocks)).toEqual(['Allowed: (不明なツール)']);
  });
});

describe('buildResolvedBlocks', () => {
  it('reflects allow', () => {
    const { text } = buildResolvedBlocks(sampleReq, 'allow', 'U123');
    expect(text).toContain('Allowed');
  });

  it('ID は plain_text で出し、mrkdwn はユーザー ID の形のメンションだけに使う', () => {
    const { blocks } = buildResolvedBlocks(sampleReq, 'allow', 'U123');
    const context = blocks[1] as { type: string; elements: { type: string; text: string }[] };
    expect(context.type).toBe('context');
    expect(context.elements).toEqual([
      { type: 'plain_text', text: 'ID: abcde ・ by' },
      { type: 'mrkdwn', text: '<@U123>' }
    ]);
  });

  it('ユーザー ID の形でない byUserId は mrkdwn に入れない', () => {
    const { blocks } = buildResolvedBlocks({ ...sampleReq, request_id: '*x* <!here>' }, 'deny', '<!channel>');
    const context = blocks[1] as { elements: { type: string; text: string }[] };
    expect(context.elements.every((e) => e.type === 'plain_text')).toBe(true);
    expect(context.elements.map((e) => e.text)).toEqual(['ID: *x* <!here> ・ by', '<!channel>']);
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

describe('buildAutoDeniedBlocks', () => {
  it('ID と自動で拒否した理由を plain_text で出す', () => {
    const { text, blocks } = buildAutoDeniedBlocks('abcde', '期限切れ');
    expect(text).toContain('abcde');
    expect(text).toContain('期限切れのため自動で拒否した');
    expect(blocks).toEqual([{ type: 'section', text: { type: 'plain_text', text } }]);
  });
});

describe('PendingPermissions.remove', () => {
  it('期限に関係なく取り出して消す', () => {
    let now = 1000;
    const pending = new PendingPermissions(1000, () => now);
    pending.add(sampleReq);
    now = 5000;
    expect(pending.remove('abcde')).toEqual(sampleReq);
    expect(pending.remove('abcde')).toBeUndefined();
    expect(pending.ttl).toBe(1000);
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
