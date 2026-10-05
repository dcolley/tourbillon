import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { db } from './client';
import { agentObservabilityEvents, companies, agents } from './schema';
import { detectTruncatedGeneration } from './observability-queries';
import { sql } from 'drizzle-orm';

describe('detectTruncatedGeneration', () => {
  const testCompanyId = 'test-company-truncation';
  const testAgentId = 'test-agent-truncation';
  const testRunId = 'test-run-truncation';

  beforeEach(async () => {
    await db.delete(agentObservabilityEvents).where(sql`true`);
    await db.delete(agents).where(sql`true`);
    await db.delete(companies).where(sql`true`);

    await db.insert(companies).values({
      id: testCompanyId,
      name: 'Test Company',
      status: 'active',
    });

    await db.insert(agents).values({
      id: testAgentId,
      companyId: testCompanyId,
      name: 'Test Agent',
      role: 'engineer',
      urlKey: 'test-agent',
      modelId: 'test-model',
      status: 'active',
    });
  });

  afterEach(async () => {
    await db.delete(agentObservabilityEvents).where(sql`true`);
    await db.delete(agents).where(sql`true`);
    await db.delete(companies).where(sql`true`);
  });

  it('detects truncation when finishReason is length', async () => {
    await db.insert(agentObservabilityEvents).values({
      companyId: testCompanyId,
      traceId: 'trace-1',
      spanId: 'span-1',
      heartbeatRunId: testRunId,
      agentId: testAgentId,
      eventType: 'model_inference',
      name: 'model_inference',
      status: 'ok',
      payload: {
        attributes: {
          finishReason: 'length',
        },
      },
      occurredAt: new Date(),
    });

    const result = await detectTruncatedGeneration(testRunId);
    assert.equal(result.truncated, true);
    if (result.truncated) {
      assert.equal(result.finishReason, 'length');
      assert.ok(result.errorText.includes('truncated'));
    }
  });

  it('returns no truncation when finishReason is stop', async () => {
    await db.insert(agentObservabilityEvents).values({
      companyId: testCompanyId,
      traceId: 'trace-2',
      spanId: 'span-2',
      heartbeatRunId: testRunId,
      agentId: testAgentId,
      eventType: 'model_inference',
      name: 'model_inference',
      status: 'ok',
      payload: {
        attributes: {
          finishReason: 'stop',
        },
      },
      occurredAt: new Date(),
    });

    const result = await detectTruncatedGeneration(testRunId);
    assert.equal(result.truncated, false);
  });

  it('returns no truncation when no events exist', async () => {
    const result = await detectTruncatedGeneration('nonexistent-run');
    assert.equal(result.truncated, false);
  });

  it('uses errorText from event if present', async () => {
    await db.insert(agentObservabilityEvents).values({
      companyId: testCompanyId,
      traceId: 'trace-3',
      spanId: 'span-3',
      heartbeatRunId: testRunId,
      agentId: testAgentId,
      eventType: 'model_inference',
      name: 'model_inference',
      status: 'error',
      errorText: 'Custom error: output limit exceeded',
      payload: {
        attributes: {
          finishReason: 'length',
        },
      },
      occurredAt: new Date(),
    });

    const result = await detectTruncatedGeneration(testRunId);
    assert.equal(result.truncated, true);
    if (result.truncated) {
      assert.equal(result.errorText, 'Custom error: output limit exceeded');
    }
  });

  it('checks multiple events and finds truncation', async () => {
    await db.insert(agentObservabilityEvents).values([
      {
        companyId: testCompanyId,
        traceId: 'trace-4',
        spanId: 'span-4a',
        heartbeatRunId: testRunId,
        agentId: testAgentId,
        eventType: 'model_inference',
        name: 'model_inference',
        status: 'ok',
        payload: {
          attributes: {
            finishReason: 'stop',
          },
        },
        occurredAt: new Date('2026-08-25T12:00:00Z'),
      },
      {
        companyId: testCompanyId,
        traceId: 'trace-4',
        spanId: 'span-4b',
        heartbeatRunId: testRunId,
        agentId: testAgentId,
        eventType: 'model_inference',
        name: 'model_inference',
        status: 'ok',
        payload: {
          attributes: {
            finishReason: 'length',
          },
        },
        occurredAt: new Date('2026-08-25T12:01:00Z'),
      },
    ]);

    const result = await detectTruncatedGeneration(testRunId);
    assert.equal(result.truncated, true);
  });
});
