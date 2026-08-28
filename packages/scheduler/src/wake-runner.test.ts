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
    // Create per-wake detector armed with heartbeat runId (as wake-runner does)
    const heartbeatRunId = 'run-abc-123';
    const detector = new TripwireDetector(heartbeatRunId);
    
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
    
    // Simulate MODEL_STEP span with system-message tripwire DURING stream/observe
    // (Mastra 1.63+: tripwire appears in MODEL_STEP output, not separate PROCESSOR span)
    const processorSpanEvent: TracingEvent = {
      type: 'span_end' as any,
      exportedSpan: {
        id: 'span-123',
        traceId: 'trace-abc',
        type: SpanType.MODEL_STEP,
        name: 'model_step',
        requestContext: {
          get: (key: string) => (key === 'runId' ? heartbeatRunId : undefined),
        },
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
    // Create detector armed with heartbeat runId
    const heartbeatRunId = 'run-xyz-456';
    const detector = new TripwireDetector(heartbeatRunId);
    
    // Attach listener BEFORE stream starts (PRODUCTION ORDER)
    const tripwirePromise = new Promise<never>((_, reject) => {
      detector.once('tripwire', (errorText: string) => {
        reject(new Error(errorText));
      });
    });
    
    // MODEL_STEP span arrives DURING stream (with matching runId)
    const earlyProcessorSpan: TracingEvent = {
      type: 'span_end' as any,
      exportedSpan: {
        id: 'span-early',
        traceId: 'trace-early',
        type: SpanType.MODEL_STEP,
        name: 'model_step',
        requestContext: {
          get: (key: string) => (key === 'runId' ? heartbeatRunId : undefined),
        },
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
    
    // Fire event (simulating during stream, with matching runId)
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

  it('detector filters by heartbeatRunId (no collision with concurrent wakes)', async () => {
    // Two concurrent wakes with different runIds (THE COLLISION TEST)
    const runIdA = 'run-wake-A';
    const runIdB = 'run-wake-B';
    
    const detectorA = new TripwireDetector(runIdA);
    const detectorB = new TripwireDetector(runIdB);
    
    let aFired = false;
    let bFired = false;
    
    detectorA.once('tripwire', () => { aFired = true; });
    detectorB.once('tripwire', () => { bFired = true; });
    
    // MODEL_STEP span attributed to wake A (via requestContext runId)
    const spanForA: TracingEvent = {
      type: 'span_end' as any,
      exportedSpan: {
        id: 'span-for-A',
        traceId: 'trace-A',
        type: SpanType.MODEL_STEP,
        name: 'model_step',
        requestContext: {
          get: (key: string) => (key === 'runId' ? runIdA : undefined),
        },
        output: {
          reason: 'TokenLimiterProcessor: System messages alone exceed token limit.',
          options: {
            metadata: {
              systemTokens: 150000,
              limit: 120000,
            },
          },
        },
      } as any,
    };
    
    // Fire span (as if both detectors are notified by registry)
    detectorA.onTracingEvent(spanForA);
    detectorB.onTracingEvent(spanForA);
    
    // Wait a tick to ensure events processed
    await new Promise(r => setImmediate(r));
    
    // Only detector A should fire (span attributed to runIdA)
    assert.equal(aFired, true, 'Detector A must fire for span attributed to runIdA');
    assert.equal(bFired, false, 'Detector B must NOT fire for span attributed to runIdA (no collision)');
    
    // Verify errorText stored only in A
    assert.ok(detectorA.getErrorText(), 'Detector A must store errorText');
    assert.equal(detectorB.getErrorText(), null, 'Detector B must not store errorText');
    
    detectorA.clear();
    detectorB.clear();
  });

  it('detector ignores span with no heartbeatRunId (fail closed)', async () => {
    const heartbeatRunId = 'run-test-123';
    const detector = new TripwireDetector(heartbeatRunId);
    
    let tripwireFired = false;
    detector.once('tripwire', () => { tripwireFired = true; });
    
    // Span with NO heartbeatRunId attribution
    const spanNoAttribution: TracingEvent = {
      type: 'span_end' as any,
      exportedSpan: {
        id: 'span-no-attr',
        traceId: 'trace-no-attr',
        type: SpanType.MODEL_STEP,
        name: 'model_step',
        // No requestContext, no metadata with runId
        output: {
          reason: 'TokenLimiterProcessor: System messages alone exceed token limit.',
        },
      } as any,
    };
    
    detector.onTracingEvent(spanNoAttribution);
    
    // Wait a tick
    await new Promise(r => setImmediate(r));
    
    // Should NOT fire (fail closed)
    assert.equal(tripwireFired, false, 'Detector must not fire for span with no heartbeatRunId (fail closed)');
    assert.equal(detector.getErrorText(), null, 'Detector must not store errorText for unattributed span');
    
    detector.clear();
  });

  it('detector catches tripwire with metadata.heartbeatRunId (fallback path)', async () => {
    const heartbeatRunId = 'run-meta-789';
    const detector = new TripwireDetector(heartbeatRunId);
    
    const tripwirePromise = new Promise<never>((_, reject) => {
      detector.once('tripwire', (errorText: string) => {
        reject(new Error(errorText));
      });
    });
    
    // Span with heartbeatRunId in metadata (not requestContext)
    const spanMetadata: TracingEvent = {
      type: 'span_end' as any,
      exportedSpan: {
        id: 'span-meta',
        traceId: 'trace-meta',
        type: SpanType.MODEL_STEP,
        name: 'model_step',
        metadata: {
          heartbeatRunId: heartbeatRunId,
        },
        output: {
          reason: 'TokenLimiterProcessor: System messages alone exceed token limit.',
          options: {
            metadata: {
              systemTokens: 85000,
              limit: 70000,
            },
          },
        },
      } as any,
    };
    
    detector.onTracingEvent(spanMetadata);
    
    // Should fire using metadata.heartbeatRunId
    await assert.rejects(
      tripwirePromise,
      (err: Error) => {
        assert.match(err.message, /System messages are 85000 tokens/);
        return true;
      },
      'Detector must fire for span with metadata.heartbeatRunId'
    );
    
    detector.clear();
  });

  it('detector filters by traceId after setTraceId (additional filtering)', async () => {
    const heartbeatRunId = 'run-trace-test';
    const detector = new TripwireDetector(heartbeatRunId);
    detector.setTraceId('trace-target');
    
    let tripwireFired = false;
    detector.once('tripwire', () => { tripwireFired = true; });
    
    // Span with matching runId but DIFFERENT traceId - should be ignored after setTraceId
    const wrongTraceSpan: TracingEvent = {
      type: 'span_end' as any,
      exportedSpan: {
        id: 'span-wrong-trace',
        traceId: 'trace-other',
        type: SpanType.MODEL_STEP,
        name: 'model_step',
        requestContext: {
          get: (key: string) => (key === 'runId' ? heartbeatRunId : undefined),
        },
        output: {
          reason: 'TokenLimiterProcessor: System messages alone exceed token limit.',
        },
      } as any,
    };
    
    detector.onTracingEvent(wrongTraceSpan);
    
    // Wait a tick
    await new Promise(r => setImmediate(r));
    
    assert.equal(tripwireFired, false, 'Detector must not fire for wrong traceId (even with matching runId)');
    
    // Now fire correct traceId with matching runId
    const correctSpan: TracingEvent = {
      type: 'span_end' as any,
      exportedSpan: {
        id: 'span-correct',
        traceId: 'trace-target',
        type: SpanType.MODEL_STEP,
        name: 'model_step',
        requestContext: {
          get: (key: string) => (key === 'runId' ? heartbeatRunId : undefined),
        },
        output: {
          reason: 'TokenLimiterProcessor: System messages alone exceed token limit.',
        },
      } as any,
    };
    
    detector.onTracingEvent(correctSpan);
    
    assert.equal(tripwireFired, true, 'Detector must fire for matching runId AND traceId');
    
    detector.clear();
  });
});
