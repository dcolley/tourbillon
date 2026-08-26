import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeAssigneeKey,
  ISSUE_TABLE_UNASSIGNED,
  ISSUE_TABLE_BOARD,
} from './issue-list-storage';

describe('sanitizeAssigneeKey', () => {
  const validAgentUrlKeys = ['ceo', 'cto', 'engineer-1'];

  it('returns null when assigneeKey is null', () => {
    assert.strictEqual(sanitizeAssigneeKey(null, validAgentUrlKeys), null);
  });

  it('returns null when assigneeKey is empty string', () => {
    assert.strictEqual(sanitizeAssigneeKey('', validAgentUrlKeys), null);
  });

  it('preserves __unassigned__ special value', () => {
    assert.strictEqual(
      sanitizeAssigneeKey(ISSUE_TABLE_UNASSIGNED, validAgentUrlKeys),
      ISSUE_TABLE_UNASSIGNED,
    );
  });

  it('preserves __board__ special value', () => {
    assert.strictEqual(sanitizeAssigneeKey(ISSUE_TABLE_BOARD, validAgentUrlKeys), ISSUE_TABLE_BOARD);
  });

  it('preserves valid agent urlKey', () => {
    assert.strictEqual(sanitizeAssigneeKey('ceo', validAgentUrlKeys), 'ceo');
    assert.strictEqual(sanitizeAssigneeKey('cto', validAgentUrlKeys), 'cto');
    assert.strictEqual(sanitizeAssigneeKey('engineer-1', validAgentUrlKeys), 'engineer-1');
  });

  it('resets stale agent urlKey to null (unknown to current company)', () => {
    assert.strictEqual(sanitizeAssigneeKey('demo-agent', validAgentUrlKeys), null);
    assert.strictEqual(sanitizeAssigneeKey('unknown-urlKey', validAgentUrlKeys), null);
  });

  it('resets stale urlKey to null even with empty agent list', () => {
    assert.strictEqual(sanitizeAssigneeKey('any-agent', []), null);
  });

  it('handles case-sensitive comparison (urlKeys must match exactly)', () => {
    assert.strictEqual(sanitizeAssigneeKey('CEO', validAgentUrlKeys), null);
    assert.strictEqual(sanitizeAssigneeKey('CTO', validAgentUrlKeys), null);
  });
});
