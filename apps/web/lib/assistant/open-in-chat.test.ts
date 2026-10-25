/** UI-3: Open in chat link builder and the context read back by the assistant page. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPEN_IN_CHAT_TITLE_MAX,
  cleanContextTitle,
  contextChipLabel,
  isOpenInChatContextType,
  openInChatHref,
  parseOpenInChatContext,
} from './open-in-chat';

const ISSUE_ID = '3f2a9c1e-0b7d-4e55-9a10-2c4b6d8e0f12';

describe('UI-3 openInChatHref', () => {
  it('builds /assistant/<agent-url-key>?context=<type>:<id>', () => {
    assert.equal(
      openInChatHref({ agentUrlKey: 'alice', contextType: 'issue', contextId: ISSUE_ID }),
      `/assistant/alice?context=issue%3A${ISSUE_ID}`,
    );
  });

  it('adds the title when given (trimmed, encoded)', () => {
    const href = openInChatHref({ agentUrlKey: 'alice', contextType: 'issue', contextId: 'i-1', contextTitle: '  Fix login & signup ' });
    assert.equal(href, '/assistant/alice?context=issue%3Ai-1&contextTitle=Fix+login+%26+signup');
    const params = new URL(href!, 'http://x').searchParams;
    assert.equal(params.get('context'), 'issue:i-1');
    assert.equal(params.get('contextTitle'), 'Fix login & signup');
  });

  it('encodes the agent url key as a path segment', () => {
    assert.equal(openInChatHref({ agentUrlKey: 'a b', contextType: 'goal', contextId: 'g1' }), '/assistant/a%20b?context=goal%3Ag1');
  });

  it('no agent url key → null (no button)', () => {
    for (const agentUrlKey of [undefined, null, '', '   ', '..', 'a/b']) {
      assert.equal(openInChatHref({ agentUrlKey, contextType: 'issue', contextId: 'i-1' }), null, String(agentUrlKey));
    }
  });

  it('without a usable context type or id, links the agent chat only', () => {
    assert.equal(openInChatHref({ agentUrlKey: 'alice', contextType: 'issue' }), '/assistant/alice');
    assert.equal(openInChatHref({ agentUrlKey: 'alice', contextType: 'free', contextId: 'x' }), '/assistant/alice');
    assert.equal(openInChatHref({ agentUrlKey: 'alice', contextType: 'issue', contextId: 'a/b' }), '/assistant/alice');
  });

  it('every page context type is accepted', () => {
    for (const t of ['issue', 'project', 'goal', 'heartbeat', 'agent', 'board']) assert.equal(isOpenInChatContextType(t), true, t);
    for (const t of ['free', '', 'Issue', null, 1]) assert.equal(isOpenInChatContextType(t), false, String(t));
  });
});

describe('UI-3 parseOpenInChatContext', () => {
  it('reads type, id and title', () => {
    assert.deepEqual(parseOpenInChatContext({ context: `issue:${ISSUE_ID}`, contextTitle: 'Fix login' }), {
      contextType: 'issue',
      contextId: ISSUE_ID,
      contextTitle: 'Fix login',
    });
    assert.deepEqual(parseOpenInChatContext({ context: 'board:board' }), { contextType: 'board', contextId: 'board' });
  });

  it('round-trips what openInChatHref builds', () => {
    const href = openInChatHref({ agentUrlKey: 'alice', contextType: 'project', contextId: 'p-1', contextTitle: 'Q3 launch' })!;
    const sp = new URL(href, 'http://x').searchParams;
    assert.deepEqual(parseOpenInChatContext({ context: sp.get('context')!, contextTitle: sp.get('contextTitle')! }), {
      contextType: 'project',
      contextId: 'p-1',
      contextTitle: 'Q3 launch',
    });
  });

  it('first value of a repeated param', () => {
    assert.deepEqual(parseOpenInChatContext({ context: ['goal:g1', 'issue:i1'] }), { contextType: 'goal', contextId: 'g1' });
  });

  it('missing or unusable → null', () => {
    for (const context of [undefined, '', 'issue', ':i1', 'issue:', 'free:x', 'nope:x', 'issue:a/b', 'issue:..']) {
      assert.equal(parseOpenInChatContext({ context }), null, String(context));
    }
    assert.equal(parseOpenInChatContext(null), null);
    assert.equal(parseOpenInChatContext(undefined), null);
  });

  it('cleans the title: control characters, whitespace, length', () => {
    assert.equal(cleanContextTitle('a\n\tb\u0000c'), 'a b c');
    assert.equal(cleanContextTitle('   '), undefined);
    assert.equal(cleanContextTitle(undefined), undefined);
    const long = cleanContextTitle('x'.repeat(500))!;
    assert.equal(long.length, OPEN_IN_CHAT_TITLE_MAX);
    assert.ok(long.endsWith('…'));
    assert.deepEqual(parseOpenInChatContext({ context: 'issue:i1', contextTitle: ' ' }), { contextType: 'issue', contextId: 'i1' });
  });
});

describe('UI-3 contextChipLabel', () => {
  it('type and title, else type and short id; the board shows its name', () => {
    assert.equal(contextChipLabel({ contextType: 'issue', contextId: ISSUE_ID, contextTitle: 'Fix login' }), 'Issue: Fix login');
    assert.equal(contextChipLabel({ contextType: 'issue', contextId: ISSUE_ID }), 'Issue 3f2a9c1e');
    assert.equal(contextChipLabel({ contextType: 'board', contextId: 'board' }), 'Issue board');
    assert.equal(contextChipLabel({ contextType: 'heartbeat', contextId: 'r1', contextTitle: 'Heartbeat r1' }), 'Heartbeat: Heartbeat r1');
  });
});
