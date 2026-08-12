import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  heartbeatProgressStaleErrorText,
  isTokenLimiterTripwireError,
  parseCompanySettings,
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

  it('tripwireErrorFromUnknown wraps limiter errors', () => {
    const err = tripwireErrorFromUnknown(
      new Error('TokenLimiterProcessor: No messages to process.'),
    );
    assert.match(err.message, /TokenLimiter tripwire/);
  });
});
