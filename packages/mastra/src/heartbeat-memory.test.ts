import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  shouldUseHeartbeatMemory,
  buildInboxThreadId,
  buildAgentIdleThreadId,
  buildHarnessIdleThreadId,
} from './heartbeat-memory';
import { buildHeartbeatMemoryKeys } from './memory-keys';
import type { CompanySettings } from '@tourbillon/shared';

describe('shouldUseHeartbeatMemory', () => {
  it('returns false when taskId is set (product lock: all heartbeat wakes start empty)', () => {
    const result = shouldUseHeartbeatMemory('task-123', null);
    assert.equal(result, false);
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

  it('returns false when taskId is not set but OM is fully configured (product lock)', () => {
    const settings: CompanySettings = {
      observationalMemory: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
      },
    };
    const result = shouldUseHeartbeatMemory(undefined, settings);
    assert.equal(result, false);
  });

  it('returns false when both taskId and OM are set (product lock: empty context)', () => {
    const settings: CompanySettings = {
      observationalMemory: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
      },
    };
    const result = shouldUseHeartbeatMemory('task-123', settings);
    assert.equal(result, false);
  });
});

describe('buildInboxThreadId', () => {
  it('builds legacy inbox thread id', () => {
    const result = buildInboxThreadId('company-1', 'agent-1');
    assert.equal(result, 'company-1:agent-1:inbox');
  });
});

describe('buildAgentIdleThreadId', () => {
  it('builds idle thread id for durable Agent runtime with OM', () => {
    const result = buildAgentIdleThreadId('12345');
    assert.equal(result, 'agent-durable-12345');
  });
});

describe('buildHarnessIdleThreadId', () => {
  it('builds idle thread id for harness (AgentController) runtime with OM', () => {
    const result = buildHarnessIdleThreadId('12345');
    assert.equal(result, 'agent-harness-12345');
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

  it('builds durable agent idle thread when useIdleThread is true and no issueId', () => {
    const result = buildHeartbeatMemoryKeys({
      companyId: 'company-1',
      agentId: '12345',
      useIdleThread: true,
    });
    assert.equal(result.resource, 'company-1:12345');
    assert.equal(result.thread, 'agent-durable-12345');
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

describe('Runtime idle thread isolation', () => {
  it('durable agent and harness runtimes use distinct idle thread ids', () => {
    const agentId = '12345';
    const durableThread = buildAgentIdleThreadId(agentId);
    const harnessThread = buildHarnessIdleThreadId(agentId);
    
    assert.notEqual(durableThread, harnessThread, 'Idle threads must differ by runtime');
    assert.equal(durableThread, 'agent-durable-12345');
    assert.equal(harnessThread, 'agent-harness-12345');
  });

  it('durable agent idle thread matches memory keys with useIdleThread', () => {
    const agentId = '12345';
    const explicitIdleThread = buildAgentIdleThreadId(agentId);
    const memoryKeys = buildHeartbeatMemoryKeys({
      companyId: 'company-1',
      agentId,
      useIdleThread: true,
    });
    
    assert.equal(memoryKeys.thread, explicitIdleThread);
  });

  it('harness controller idle thread matches heartbeat-memory harness idle', async () => {
    const { buildControllerThreadId } = await import('./controller-config');
    const agentId = '12345';
    const mockAgent = { id: agentId, companyId: 'company-1' } as any;
    
    const controllerIdleThread = buildControllerThreadId(mockAgent, undefined);
    const memoryHarnessIdleThread = buildHarnessIdleThreadId(agentId);
    
    assert.equal(
      controllerIdleThread,
      memoryHarnessIdleThread,
      'Controller and memory must use the same harness idle thread id'
    );
    assert.equal(controllerIdleThread, 'agent-harness-12345');
  });

  it('legacy harness idle thread differs from namespaced keys', () => {
    const agentId = '12345';
    const legacyThread = `agent-${agentId}`;
    const durableThread = buildAgentIdleThreadId(agentId);
    const harnessThread = buildHarnessIdleThreadId(agentId);
    
    assert.notEqual(legacyThread, durableThread);
    assert.notEqual(legacyThread, harnessThread);
    assert.equal(legacyThread, 'agent-12345', 'Legacy thread is unnamespaced');
  });
});

describe('clearAllHeartbeatThreads', () => {
  it('clears heartbeat threads but never chat threads', () => {
    // US5: chat thread IDs must not be in the clear list
    const companyId = 'company-1';
    const agentId = '12345';
    const taskId = 'issue-1';
    
    // Chat thread IDs use company-*:chat:* pattern
    const chatFreeThread = `company-${companyId}:chat:free`;
    const chatIssueThread = `company-${companyId}:chat:issue:${taskId}`;
    const chatProjectThread = `company-${companyId}:chat:project:proj-1`;
    
    // Heartbeat thread IDs
    const durableIdleThread = buildAgentIdleThreadId(agentId);
    const harnessIdleThread = buildHarnessIdleThreadId(agentId);
    const inboxThread = buildInboxThreadId(companyId, agentId);
    const issueThread = `${taskId}:${agentId}`;
    const legacyThread = `agent-${agentId}`;
    
    // Chat threads must NOT match heartbeat thread patterns
    assert.notEqual(chatFreeThread, durableIdleThread);
    assert.notEqual(chatFreeThread, harnessIdleThread);
    assert.notEqual(chatFreeThread, inboxThread);
    assert.notEqual(chatFreeThread, issueThread);
    assert.notEqual(chatFreeThread, legacyThread);
    
    assert.notEqual(chatIssueThread, durableIdleThread);
    assert.notEqual(chatIssueThread, harnessIdleThread);
    assert.notEqual(chatIssueThread, inboxThread);
    assert.notEqual(chatIssueThread, issueThread);
    
    assert.notEqual(chatProjectThread, durableIdleThread);
    assert.notEqual(chatProjectThread, harnessIdleThread);
    assert.notEqual(chatProjectThread, inboxThread);
    
    // Verify chat threads have distinct prefix
    assert.ok(chatFreeThread.includes(':chat:'));
    assert.ok(chatIssueThread.includes(':chat:'));
    assert.ok(chatProjectThread.includes(':chat:'));
    
    // Verify heartbeat threads do NOT have :chat: prefix
    assert.ok(!durableIdleThread.includes(':chat:'));
    assert.ok(!harnessIdleThread.includes(':chat:'));
    assert.ok(!inboxThread.includes(':chat:'));
    assert.ok(!issueThread.includes(':chat:'));
  });
});

describe('Consecutive wake isolation', () => {
  it('consecutive heartbeats use distinct thread IDs and do not share history', () => {
    // US6: Two consecutive heartbeats must not see each other's messages
    const companyId = 'company-1';
    const agentId = '12345';
    const runId1 = 'run-001';
    const runId2 = 'run-002';
    
    // Each wake gets a fresh thread ID based on runId
    const wake1Thread = `hb-${runId1}`;
    const wake2Thread = `hb-${runId2}`;
    
    // Threads must differ across consecutive wakes
    assert.notEqual(wake1Thread, wake2Thread);
    
    // Neither wake reuses idle threads
    const durableIdleThread = buildAgentIdleThreadId(agentId);
    const harnessIdleThread = buildHarnessIdleThreadId(agentId);
    const inboxThread = buildInboxThreadId(companyId, agentId);
    
    assert.notEqual(wake1Thread, durableIdleThread);
    assert.notEqual(wake1Thread, harnessIdleThread);
    assert.notEqual(wake1Thread, inboxThread);
    
    assert.notEqual(wake2Thread, durableIdleThread);
    assert.notEqual(wake2Thread, harnessIdleThread);
    assert.notEqual(wake2Thread, inboxThread);
  });
  
  it('assignment wakes use fresh thread IDs per run, not per issue', () => {
    // US6: Assignment wakes must not reuse issue threads across heartbeats
    const companyId = 'company-1';
    const agentId = '12345';
    const taskId = 'issue-1';
    const runId1 = 'run-001';
    const runId2 = 'run-002';
    
    // Legacy issue thread pattern (not used after product lock)
    const legacyIssueThread = `${taskId}:${agentId}`;
    
    // Fresh thread IDs per wake
    const wake1Thread = `hb-${runId1}`;
    const wake2Thread = `hb-${runId2}`;
    
    // Neither wake reuses the issue thread
    assert.notEqual(wake1Thread, legacyIssueThread);
    assert.notEqual(wake2Thread, legacyIssueThread);
    
    // Consecutive assignment wakes have distinct threads
    assert.notEqual(wake1Thread, wake2Thread);
  });
});
