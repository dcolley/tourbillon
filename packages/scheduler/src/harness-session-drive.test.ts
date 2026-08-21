import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  heartbeatProgressStaleErrorText,
  isResumableWakeMatch,
  isTokenLimiterTripwireError,
  parseCompanySettings,
  resolveContextBudget,
  resolveObservationalMemoryModel,
} from '@tourbillon/shared';
import {
  driveSessionHeadless,
  isHarnessProgressEvent,
  tripwireErrorFromUnknown,
} from './harness-session-drive';
import type { AgentControllerEvent } from '@tourbillon/mastra';

describe('resolveObservationalMemoryModel', () => {
  it('resolves enabled company OM settings', () => {
    const settings = parseCompanySettings({
      observationalMemory: {
        enabled: true,
        providerId: 'prov-1',
        modelId: 'local/model',
      },
    });
    assert.deepEqual(resolveObservationalMemoryModel(settings), {
      providerId: 'prov-1',
      modelId: 'local/model',
    });
  });

  it('returns null when OM is disabled', () => {
    assert.equal(
      resolveObservationalMemoryModel({
        observationalMemory: { enabled: false, providerId: 'p', modelId: 'm' },
      }),
      null,
    );
  });
});

describe('isResumableWakeMatch', () => {
  it('rejects on-demand and timer wakes with no taskId', () => {
    assert.equal(isResumableWakeMatch(undefined, 'issue-1'), false);
    assert.equal(isResumableWakeMatch(undefined, undefined), false);
  });

  it('requires the snapshot taskId to match the wake taskId', () => {
    assert.equal(isResumableWakeMatch('issue-1', 'issue-1'), true);
    assert.equal(isResumableWakeMatch('issue-1', 'issue-2'), false);
    assert.equal(isResumableWakeMatch('issue-1', undefined), false);
  });
});

describe('resolveContextBudget', () => {
  it('falls back to the env limiter when no context window is set', () => {
    const budget = resolveContextBudget({
      kind: 'durable',
      envLimit: 120_000,
    });
    assert.equal(budget.contextTokens, null);
    assert.equal(budget.limiterLimit, 120_000);
    assert.equal(budget.observationThreshold, 30_000);
    assert.equal(budget.reflectionThreshold, 40_000);
  });

  it('reserves output and harness tool schemas under the model window', () => {
    const budget = resolveContextBudget({
      kind: 'harness',
      maxContextTokens: 131_072,
      maxOutputTokens: 4_096,
    });
    assert.equal(budget.limiterLimit, 131_072 - 4_096 - 16_000);
    assert.ok(budget.observationThreshold < budget.limiterLimit);
    assert.ok(budget.reflectionThreshold > budget.observationThreshold);
  });
});

describe('isTokenLimiterTripwireError', () => {
  it('detects TokenLimiterProcessor messages', () => {
    assert.equal(
      isTokenLimiterTripwireError(
        new Error(
          'TokenLimiterProcessor: No messages fit within the remaining token budget. Cannot send LLM a request with no messages.',
        ),
      ),
      true,
    );
  });

  it('detects TripWire', () => {
    assert.equal(isTokenLimiterTripwireError(new Error('TripWire: blocked')), true);
  });

  it('ignores unrelated errors', () => {
    assert.equal(isTokenLimiterTripwireError(new Error('network timeout')), false);
  });
});

describe('isHarnessProgressEvent', () => {
  it('treats tool and OM events as progress', () => {
    assert.equal(isHarnessProgressEvent({ type: 'tool_start' } as AgentControllerEvent), true);
    assert.equal(
      isHarnessProgressEvent({ type: 'om_observation_end' } as AgentControllerEvent),
      true,
    );
  });
});

describe('driveSessionHeadless', () => {
  it('rejects on TokenLimiter tripwire from sendMessage', async () => {
    const listeners = new Set<(event: AgentControllerEvent) => void>();
    const session = {
      subscribe(listener: (event: AgentControllerEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      abort() {},
      getCurrentRunId() {
        return null;
      },
      run: { isRunning: () => false },
      sendMessage: async () => {
        throw new Error(
          'TokenLimiterProcessor: No messages fit within the remaining token budget.',
        );
      },
    };

    await assert.rejects(
      () =>
        driveSessionHeadless(
          session as never,
          'wake',
          {},
          () => undefined,
          undefined,
          undefined,
          60,
        ),
      (err: Error) => /TokenLimiter tripwire/i.test(err.message),
    );
  });

  it('rejects when progress watchdog fires with no events', async () => {
    const session = {
      subscribe(_listener: (event: AgentControllerEvent) => void) {
        return () => undefined;
      },
      abort() {},
      getCurrentRunId() {
        return null;
      },
      run: { isRunning: () => true },
      sendMessage: () => new Promise(() => undefined),
    };

    await assert.rejects(
      () =>
        driveSessionHeadless(
          session as never,
          'wake',
          {},
          () => undefined,
          undefined,
          undefined,
          1, // 1s progress stale for test
        ),
      (err: Error) => err.message === heartbeatProgressStaleErrorText(1),
    );
  });

  it('includes last event type and time when progress watchdog fires', async () => {
    const listeners = new Set<(event: AgentControllerEvent) => void>();
    const session = {
      subscribe(listener: (event: AgentControllerEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      abort() {},
      getCurrentRunId() {
        return null;
      },
      run: { isRunning: () => true },
      sendMessage: () => new Promise(() => undefined),
    };

    const drive = driveSessionHeadless(
      session as never,
      'wake',
      {},
      () => undefined,
      undefined,
      undefined,
      1,
    );
    for (const listener of listeners) {
      listener({ type: 'tool_end' } as AgentControllerEvent);
    }

    await assert.rejects(drive, (err: Error) => {
      assert.match(err.message, /no controller events within 1s/i);
      assert.match(err.message, /last event: tool_end at \d{4}-\d{2}-\d{2}T/);
      return true;
    });
  });

  it('tripwireErrorFromUnknown wraps limiter errors', () => {
    const err = tripwireErrorFromUnknown(
      new Error('TokenLimiterProcessor: No messages to process.'),
    );
    assert.match(err.message, /TokenLimiter tripwire/);
  });

  it('aborts when maxSteps is exceeded', async () => {
    const listeners = new Set<(event: AgentControllerEvent) => void>();
    let abortCalled = false;
    const session = {
      subscribe(listener: (event: AgentControllerEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      abort() {
        abortCalled = true;
      },
      getCurrentRunId() {
        return null;
      },
      run: { isRunning: () => true },
      sendMessage: () => new Promise(() => undefined),
    };

    const drive = driveSessionHeadless(
      session as never,
      'wake',
      {},
      () => undefined,
      undefined,
      undefined,
      60,
      3,
    );

    for (const listener of listeners) {
      listener({ type: 'message_start' } as AgentControllerEvent);
      listener({ type: 'message_start' } as AgentControllerEvent);
      listener({ type: 'message_start' } as AgentControllerEvent);
      listener({ type: 'message_start' } as AgentControllerEvent);
    }

    await assert.rejects(drive, (err: Error) => {
      assert.match(err.message, /exceeded maxSteps limit of 3/i);
      assert.equal(abortCalled, true);
      return true;
    });
  });

  it('aborts when the same tool is called 5 times in a row', async () => {
    const listeners = new Set<(event: AgentControllerEvent) => void>();
    let abortCalled = false;
    const session = {
      subscribe(listener: (event: AgentControllerEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      abort() {
        abortCalled = true;
      },
      getCurrentRunId() {
        return null;
      },
      run: { isRunning: () => true },
      sendMessage: () => new Promise(() => undefined),
    };

    const drive = driveSessionHeadless(
      session as never,
      'wake',
      {},
      () => undefined,
      undefined,
      undefined,
      60,
    );

    for (const listener of listeners) {
      listener({ type: 'tool_start', toolName: 'searxngSearch' } as AgentControllerEvent);
      listener({ type: 'tool_start', toolName: 'searxngSearch' } as AgentControllerEvent);
      listener({ type: 'tool_start', toolName: 'searxngSearch' } as AgentControllerEvent);
      listener({ type: 'tool_start', toolName: 'searxngSearch' } as AgentControllerEvent);
      listener({ type: 'tool_start', toolName: 'searxngSearch' } as AgentControllerEvent);
    }

    await assert.rejects(drive, (err: Error) => {
      assert.match(err.message, /repeated tool loop detected/i);
      assert.match(err.message, /searxngSearch/i);
      assert.equal(abortCalled, true);
      return true;
    });
  });

  it('does not abort when different tools are called', async () => {
    const listeners = new Set<(event: AgentControllerEvent) => void>();
    let abortCalled = false;
    const session = {
      subscribe(listener: (event: AgentControllerEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      abort() {
        abortCalled = true;
      },
      getCurrentRunId() {
        return null;
      },
      run: { isRunning: () => false },
      sendMessage: async () => {
        for (const listener of listeners) {
          listener({ type: 'tool_start', toolName: 'searxngSearch' } as AgentControllerEvent);
          listener({ type: 'tool_start', toolName: 'getInbox' } as AgentControllerEvent);
          listener({ type: 'tool_start', toolName: 'searxngSearch' } as AgentControllerEvent);
          listener({ type: 'tool_start', toolName: 'updateIssue' } as AgentControllerEvent);
          listener({ type: 'agent_end', reason: 'complete' } as AgentControllerEvent);
        }
      },
    };

    const result = await driveSessionHeadless(
      session as never,
      'wake',
      {},
      () => undefined,
      undefined,
      undefined,
      60,
    );

    assert.equal(abortCalled, false);
    assert.equal(result.finishReason, 'complete');
  });
});
