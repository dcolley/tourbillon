import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldInsertCheckoutActivity } from './checkout-activity';

describe('shouldInsertCheckoutActivity', () => {
  it('inserts when status is not in_progress', () => {
    const result = shouldInsertCheckoutActivity(
      { status: 'todo', executionAgentNameKey: 'agent-a' },
      'agent-a',
    );
    assert.equal(result, true, 'should insert when status is todo');
  });

  it('inserts when status is blocked', () => {
    const result = shouldInsertCheckoutActivity(
      { status: 'blocked', executionAgentNameKey: 'agent-a' },
      'agent-a',
    );
    assert.equal(result, true, 'should insert when status is blocked');
  });

  it('inserts when different agent takes over in_progress', () => {
    const result = shouldInsertCheckoutActivity(
      { status: 'in_progress', executionAgentNameKey: 'agent-a' },
      'agent-b',
    );
    assert.equal(result, true, 'should insert when different agent takes over');
  });

  it('does NOT insert when same agent re-checkouts in_progress', () => {
    const result = shouldInsertCheckoutActivity(
      { status: 'in_progress', executionAgentNameKey: 'agent-a' },
      'agent-a',
    );
    assert.equal(result, false, 'should NOT insert when same agent re-checkouts in_progress');
  });

  it('inserts when executionAgentNameKey is null (no prior agent)', () => {
    const result = shouldInsertCheckoutActivity(
      { status: 'in_progress', executionAgentNameKey: null },
      'agent-a',
    );
    assert.equal(result, true, 'should insert when no prior agent');
  });
});
