import { EventEmitter } from 'events';
import type { TracingEvent } from '@mastra/core/observability';
import { SpanType } from '@mastra/core/observability';
import { isSystemMessageTripwire, extractTripwireTokenCounts, formatSystemMessageTripwireError } from '@tourbillon/shared';

/**
 * Per-wake tripwire detector. Listens to processor span events and emits
 * 'tripwire' when a system-message tripwire is detected.
 * 
 * Accepts any processor tripwire until traceId is set (for spans that arrive
 * DURING stream/observe before runId is known), then filters by traceId.
 */
export class TripwireDetector extends EventEmitter {
  private traceId: string | null = null;
  private fired = false;

  setTraceId(traceId: string) {
    this.traceId = traceId;
  }

  /** Called by exporter for each tracing event */
  onTracingEvent(event: TracingEvent): void {
    if (this.fired) return;

    const span = event.exportedSpan;
    
    // If we have a traceId, filter by it. Otherwise accept any (armed before runId known)
    if (this.traceId && span.traceId !== this.traceId) return;

    if (span.type !== SpanType.PROCESSOR) return;
    if (!span.output || !isSystemMessageTripwire(span.output)) return;

    // Tripwire detected - fire once and mark as done
    this.fired = true;
    const counts = extractTripwireTokenCounts(span.output);
    const errorText = formatSystemMessageTripwireError(counts.systemTokens, counts.limit);
    this.emit('tripwire', errorText);
  }

  clear() {
    this.fired = false;
    this.traceId = null;
    this.removeAllListeners();
  }
}

/**
 * Registry of active per-wake detectors. The exporter notifies all registered
 * detectors for each processor span.
 */
class TripwireDetectorRegistry {
  private detectors = new Set<TripwireDetector>();

  register(detector: TripwireDetector): void {
    this.detectors.add(detector);
  }

  unregister(detector: TripwireDetector): void {
    this.detectors.delete(detector);
  }

  /** Called by exporter for each tracing event */
  onTracingEvent(event: TracingEvent): void {
    for (const detector of this.detectors) {
      detector.onTracingEvent(event);
    }
  }
}

/** Shared registry for all wakes - exporter notifies this */
export const tripwireDetectorRegistry = new TripwireDetectorRegistry();
