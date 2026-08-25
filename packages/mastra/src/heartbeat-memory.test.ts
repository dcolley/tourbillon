import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  shouldUseHeartbeatMemory,
  buildInboxThreadId,
  buildHarnessIdleThreadId,
} from './heartbeat-memory';
import { buildHeartbeatMemoryKeys } from './memory-keys';
import type { CompanySettings } from '@tourbillon/shared';

describe('shouldUseHeartbeatMemory', () => {
  it('returns true when taskId is set', () => {
    const result = shouldUseHeartbeatMemory('task-123', null);
    assert.equal(result, true);
  });

  it('returns false when taskId is not set and OM is off', () => {
    const result = shouldUseHeartbeatMemory(undefined, null);
    assert.equal(result, false);
  });

  it('returns false when taskId is not set and OM is disabled', () => {
    const settings: CompanySettings = {
      observationalMemory: { enabled: false },
    };
    const result = shouldUseHeartbeatMemory(undefined, settings);
    assert.equal(result, false);
  });

  it('returns false when taskId is not set and OM has no provider/model', () => {
    const settings: CompanySettings = {
      observationalMemory: { enabled: true },
    };
    const result = shouldUseHeartbeatMemory(undefined, settings);
    assert.equal(result, false);
  });

  it('returns true when taskId is not set but OM is fully configured', () => {
    const settings: CompanySettings = {
      observationalMemory: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
      },
    };
    const result = shouldUseHeartbeatMemory(undefined, settings);
    assert.equal(result, true);
  });

  it('returns true when both taskId and OM are set', () => {
    const settings: CompanySettings = {
      observationalMemory: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
      },
    };
    const result = shouldUseHeartbeatMemory('task-123', settings);
    assert.equal(result, true);
  });
});

describe('buildInboxThreadId', () => {
  it('builds legacy inbox thread id', () => {
    const result = buildInboxThreadId('company-1', 'agent-1');
    assert.equal(result, 'company-1:agent-1:inbox');
  });
});

describe('buildHarnessIdleThreadId', () => {
  it('builds idle thread id for harness and durable OM', () => {
    const result = buildHarnessIdleThreadId('12345');
    assert.equal(result, 'agent-12345');
  });
});

describe('buildHeartbeatMemoryKeys', () => {
  it('builds issue thread when issueId is set', () => {
    const result = buildHeartbeatMemoryKeys({
      companyId: 'company-1',
      agentId: '12345',
      issueId: 'issue-1',
    });
    assert.equal(result.resource, 'company-1:12345');
    assert.equal(result.thread, 'issue-1:12345');
  });

  it('builds idle thread when useIdleThread is true and no issueId', () => {
    const result = buildHeartbeatMemoryKeys({
      companyId: 'company-1',
      agentId: '12345',
      useIdleThread: true,
    });
    assert.equal(result.resource, 'company-1:12345');
    assert.equal(result.thread, 'agent-12345');
  });

  it('builds inbox thread when no issueId and no useIdleThread', () => {
    const result = buildHeartbeatMemoryKeys({
      companyId: 'company-1',
      agentId: '12345',
    });
    assert.equal(result.resource, 'company-1:12345');
    assert.equal(result.thread, 'company-1:12345:inbox');
  });

  it('prefers issue thread over useIdleThread', () => {
    const result = buildHeartbeatMemoryKeys({
      companyId: 'company-1',
      agentId: '12345',
      issueId: 'issue-1',
      useIdleThread: true,
    });
    assert.equal(result.resource, 'company-1:12345');
    assert.equal(result.thread, 'issue-1:12345');
  });
});
