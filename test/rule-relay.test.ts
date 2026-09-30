import { describe, expect, it } from 'vitest';
import { Logger } from '../src/log.js';
import { RuleRelay } from '../src/rule-relay.js';
import type { PermissionRequest } from '../src/permission.js';

function bash(command: string): PermissionRequest {
  return { request_id: 'abcde', tool_name: 'Bash', description: '', input_preview: JSON.stringify({ command }) };
}

function setup(deny: string[] = []) {
  const rules: string[] = [];
  const posts: { kind: string; text: string; blocks?: unknown[] }[] = [];
  let t = 0;
  let denyNow = deny;
  const relay = new RuleRelay({
    store: {
      list: () => [...rules],
      add: (r) => {
        if (rules.includes(r)) return false;
        rules.push(r);
        return true;
      },
      remove: (r) => {
        const i = rules.indexOf(r);
        if (i < 0) return false;
        rules.splice(i, 1);
        return true;
      },
    },
    loadDeny: () => denyNow,
    logger: new Logger({ stderr: false }),
    now: () => t,
    newId: () => 'prop0001',
    slack: {
      postText: async (_c, text) => {
        posts.push({ kind: 'text', text });
        return { ts: ['1.0'] };
      },
      postBlocks: async (_c, text, blocks) => {
        posts.push({ kind: 'blocks', text, blocks });
        return { ts: '2.0' };
      },
      updateBlocks: async (_c, _ts, text) => {
        posts.push({ kind: 'update', text });
      },
    },
  });
  const pressed = { channel: 'C1', ts: '2.0', threadTs: '9.0' };
  return { relay, rules, posts, pressed, advance: (ms: number) => (t += ms), setDeny: (d: string[]) => (denyNow = d) };
}

describe('RuleRelay', () => {
  it('候補を確認に出し、追加するを押したら保存する', async () => {
    const { relay, rules, posts, pressed } = setup();
    await relay.propose(bash('git status'), 'C1', '9.0');
    expect(posts[0]?.kind).toBe('blocks');
    expect(posts[0]?.text).toContain('Bash(git status:*)');

    await relay.confirm('prop0001', true, pressed, 'U1');
    expect(rules).toEqual(['Bash(git status:*)']);
    expect(posts.at(-1)?.text).toContain('追加した');
  });

  it('deny に当たるなら確認を出さず、当たった deny を知らせる', async () => {
    const { relay, rules, posts } = setup(['Bash(git status --porcelain:*)']);
    await relay.propose(bash('git status'), 'C1', '9.0');

    expect(rules).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain('deny に当たる');
    expect(posts[0]?.text).toContain('Bash(git status --porcelain:*)');
  });

  it('確認の後に deny が増えていたら、追加する前に照合し直して断る', async () => {
    const { relay, rules, posts, pressed, setDeny } = setup();
    await relay.propose(bash('git status'), 'C1', '9.0');
    setDeny(['Bash(git:*)']);
    await relay.confirm('prop0001', true, pressed, 'U1');

    expect(rules).toEqual([]);
    expect(posts.at(-1)?.text).toContain('deny に当たる');
  });

  it('危険なコマンドは候補を作らず理由を知らせる', async () => {
    const { relay, posts } = setup();
    await relay.propose(bash('rm -rf dist'), 'C1', '9.0');
    expect(posts[0]?.kind).toBe('text');
    expect(posts[0]?.text).toContain('危険なコマンド');
  });

  it('やめる・期限切れでは保存しない', async () => {
    const { relay, rules, posts, pressed, advance } = setup();
    await relay.propose(bash('git status'), 'C1', '9.0');
    await relay.confirm('prop0001', false, pressed, 'U1');
    expect(posts.at(-1)?.text).toContain('追加しなかった');

    await relay.propose(bash('git status'), 'C1', '9.0');
    advance(10 * 60 * 1000 + 1);
    await relay.confirm('prop0001', true, pressed, 'U1');
    expect(posts.at(-1)?.text).toContain('期限切れ');
    expect(rules).toEqual([]);
  });

  it('一覧は削除ボタン（action_id は重複しない）付きで出し、削除できる', async () => {
    const { relay, rules, posts, pressed } = setup();
    rules.push('Bash(git status:*)', 'WebFetch');
    await relay.list('C1', '9.0');
    const actions = (posts[0]?.blocks as { type: string; elements?: { action_id: string; value: string }[] }[]).find(
      (b) => b.type === 'actions'
    );
    expect(actions?.elements?.map((e) => [e.action_id, e.value])).toEqual([
      ['rule_remove_0', 'Bash(git status:*)'],
      ['rule_remove_1', 'WebFetch'],
    ]);

    await relay.remove('WebFetch', pressed, 'U1');
    expect(rules).toEqual(['Bash(git status:*)']);
  });

  it('一覧が空ならその旨を返す', async () => {
    const { relay, posts } = setup();
    await relay.list('C1', '9.0');
    expect(posts[0]?.text).toContain('無い');
  });
});
