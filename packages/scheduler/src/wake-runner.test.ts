import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { durableWakeOutcomeFromTripwire } from './durable-wake-outcome';
import { TripwireDetector } from '@tourbillon/mastra';
import { SpanType } from '@mastra/core/observability';
import type { TracingEvent } from '@mastra/core/observability';

describe('durableWakeOutcomeFromTripwire', () => {
  it('returns recordSuccess false on Mastra tripwire with full metadata', () => {
    const tripwireData = {
      reason: 'TokenLimiterProcessor: System messages alone exceed token limit. Requests cannot be completed by removing system messages.',
      options: {
        metadata: {
          systemTokens: 150000,
          limit: 120000,
        },
      },
    };
    
    const outcome = durableWakeOutcomeFromTripwire(tripwireData);
    
    // This test FAILS if recordHeartbeatSuccess would still run
    assert.equal(outcome.recordSuccess, false, 'Must not record success on tripwire');
    
    if (!outcome.recordSuccess) {
      assert.equal(
        outcome.errorText,
        'System messages are 150000 tokens (limit 120000). Cannot trim further.',
        'Error text must include N and M from metadata'
      );
    }
  });

  it('returns recordSuccess false on tripwire with partial metadata', () => {
    const tripwireData = {
      reason: 'System messages alone exceed token limit',
      options: {
        metadata: {
          systemTokens: 95000,
        },
      },
    };
    
    const outcome = durableWakeOutcomeFromTripwire(tripwireData);
    
    assert.equal(outcome.recordSuccess, false, 'Must not record success on tripwire');
    
    if (!outcome.recordSuccess) {
      assert.equal(
        outcome.errorText,
        'System messages are 95000 tokens. Cannot trim further.',
        'Error text must include N from metadata'
      );
    }
  });

  it('returns recordSuccess false on tripwire with no metadata', () => {
    const tripwireData = {
      reason: 'System messages alone exceed token limit',
    };
    
    const outcome = durableWakeOutcomeFromTripwire(tripwireData);
    
    assert.equal(outcome.recordSuccess, false, 'Must not record success on tripwire');
    
    if (!outcome.recordSuccess) {
      assert.equal(
        outcome.errorText,
        'System messages alone exceed token limit. Cannot trim further.',
        'Error text must use fallback format'
      );
    }
  });

  it('returns recordSuccess true when no tripwire (successful trim)', () => {
    const noTripwireData = undefined;
    
    const outcome = durableWakeOutcomeFromTripwire(noTripwireData);
    
    assert.equal(outcome.recordSuccess, true, 'Must record success when no tripwire');
  });

  it('returns recordSuccess true on null tripwire', () => {
    const outcome = durableWakeOutcomeFromTripwire(null);
    
    assert.equal(outcome.recordSuccess, true, 'Must record success on null tripwire');
  });

  it('returns recordSuccess true on non-tripwire data', () => {
    const normalData = {
      someOtherField: 'normal operation',
    };
    
    const outcome = durableWakeOutcomeFromTripwire(normalData);
    
    assert.equal(outcome.recordSuccess, true, 'Must record success on non-tripwire data');
  });
});

describe('TripwireDetector real-time detection', () => {
  it('detector catches processor tripwire even when output.text never settles (PRODUCTION ORDER)', async () => {
    // Create per-wake detector (as wake-runner does)
    const detector = new TripwireDetector();
    
    // Attach listener BEFORE stream/observe starts (PRODUCTION ORDER)
    const tripwirePromise = new Promise<never>((_, reject) => {
      detector.once('tripwire', (errorText: string) => {
        reject(new Error(errorText));
      });
    });
    
    // Simulate output.text that never settles (as in TEST hang)
    const neverSettlingText = new Promise<string>(() => {
      // Never resolves or rejects
    });
    
    // Simulate processor span with system-message tripwire DURING stream/observe
    const processorSpanEvent: TracingEvent = {
      type: 'span_end' as any,
      exportedSpan: {
        id: 'span-123',
        traceId: 'trace-abc',
        type: SpanType.PROCESSOR,
        name: 'input_processor',
        output: {
          reason: 'TokenLimiterProcessor: System messages alone exceed token limit. Requests cannot be completed by removing system messages.',
          options: {
            metadata: {
              systemTokens: 150000,
              limit: 120000,
            },
          },
        },
      } as any,
    };
    
    // Fire the processor span event (as exporter does during stream/observe)
    detector.onTracingEvent(processorSpanEvent);
    
    // Race: tripwire should reject immediately even though text never settles
    const racePromise = Promise.race([
      neverSettlingText,
      tripwirePromise,
    ]);
    
    // This should reject with the tripwire error, not hang forever
    await assert.rejects(
      racePromise,
      (err: Error) => {
        assert.match(err.message, /System messages are 150000 tokens \(limit 120000\)/);
        return true;
      },
      'Race must reject with formatted tripwire error even when output.text never settles'
    );
    
    detector.clear();
  });

  it('detector stores errorText so wake-runner can check after stream returns (PRODUCTION ORDER)', async () => {
    // Create detector
    const detector = new TripwireDetector();
    
    // Attach listener BEFORE stream starts (PRODUCTION ORDER)
    const tripwirePromise = new Promise<never>((_, reject) => {
      detector.once('tripwire', (errorText: string) => {
        reject(new Error(errorText));
      });
    });
    
    // Processor span arrives DURING stream (before we get runId back)
    const earlyProcessorSpan: TracingEvent = {
      type: 'span_end' as any,
      exportedSpan: {
        id: 'span-early',
        traceId: 'trace-early',
        type: SpanType.PROCESSOR,
        name: 'input_processor',
        output: {
          reason: 'TokenLimiterProcessor: System messages alone exceed token limit.',
          options: {
            metadata: {
              systemTokens: 95000,
              limit: 80000,
            },
          },
        },
      } as any,
    };
    
    // Fire event (simulating during stream, before we have runId)
    detector.onTracingEvent(earlyProcessorSpan);
    
    // Check stored errorText (as wake-runner does after stream() returns)
    const storedError = detector.getErrorText();
    assert.ok(storedError, 'Detector must store errorText when tripwire fires');
    assert.match(storedError, /System messages are 95000 tokens \(limit 80000\)/);
    
    // tripwirePromise should also reject
    await assert.rejects(
      tripwirePromise,
      (err: Error) => {
        assert.match(err.message, /System messages are 95000 tokens/);
        return true;
      },
      'Listener must also fire'
    );
    
    detector.clear();
  });

  it('detector catches tripwire BEFORE traceId is set (during stream/observe) (PRODUCTION ORDER)', async () => {
    // Create detector without traceId (armed before stream/observe returns)
    const detector = new TripwireDetector();
    
    // Attach listener BEFORE firing span (PRODUCTION ORDER)
    let tripwireFired = false;
    let capturedError = '';
    detector.once('tripwire', (errorText: string) => {
      tripwireFired = true;
      capturedError = errorText;
    });
    
    // Processor span arrives BEFORE we get runId back (DURING stream/observe)
    const earlyProcessorSpan: TracingEvent = {
      type: 'span_end' as any,
      exportedSpan: {
        id: 'span-early',
        traceId: 'trace-early',
        type: SpanType.PROCESSOR,
        name: 'input_processor',
        output: {
          reason: 'TokenLimiterProcessor: System messages alone exceed token limit.',
          options: {
            metadata: {
              systemTokens: 95000,
              limit: 80000,
            },
          },
        },
      } as any,
    };
    
    // Fire event BEFORE setTraceId (this is the TEST bug case)
    detector.onTracingEvent(earlyProcessorSpan);
    
    // Wait a tick to ensure event fired
    await new Promise(r => setImmediate(r));
    
    assert.equal(tripwireFired, true, 'Detector must fire for processor tripwire even without traceId');
    assert.match(capturedError, /System messages are 95000 tokens/);
    
    // Now set traceId (simulating getting runId back from stream/observe)
    detector.setTraceId('trace-early');
    
    // Stored errorText should also be available
    const storedError = detector.getErrorText();
    assert.ok(storedError, 'Stored errorText must be available');
    assert.match(storedError, /System messages are 95000 tokens/);
    
    detector.clear();
  });

  it('detector filters by traceId after it is set', async () => {
    const detector = new TripwireDetector();
    detector.setTraceId('trace-target');
    
    let tripwireFired = false;
    detector.once('tripwire', () => {
      tripwireFired = true;
    });
    
    // Span with DIFFERENT traceId - should be ignored
    const wrongTraceSpan: TracingEvent = {
      type: 'span_end' as any,
      exportedSpan: {
        id: 'span-wrong',
        traceId: 'trace-other',
        type: SpanType.PROCESSOR,
        name: 'input_processor',
        output: {
          reason: 'TokenLimiterProcessor: System messages alone exceed token limit.',
        },
      } as any,
    };
    
    detector.onTracingEvent(wrongTraceSpan);
    
    // Wait a tick to ensure no async firing
    await new Promise(r => setImmediate(r));
    
    assert.equal(tripwireFired, false, 'Detector must not fire for wrong traceId');
    
    // Now fire correct traceId
    const correctTraceSpan: TracingEvent = {
      type: 'span_end' as any,
      exportedSpan: {
        id: 'span-correct',
        traceId: 'trace-target',
        type: SpanType.PROCESSOR,
        name: 'input_processor',
        output: {
          reason: 'TokenLimiterProcessor: System messages alone exceed token limit.',
        },
      } as any,
    };
    
    detector.onTracingEvent(correctTraceSpan);
    
    assert.equal(tripwireFired, true, 'Detector must fire for matching traceId');
    
    detector.clear();
  });
});
