import { EventEmitter } from 'events';
import type { TracingEvent } from '@mastra/core/observability';
import { SpanType } from '@mastra/core/observability';
import { isSystemMessageTripwire, extractTripwireTokenCounts, formatSystemMessageTripwireError } from '@tourbillon/shared';

/**
 * Detects processor tripwires in real-time by listening to tracing events.
 * Emits 'tripwire' event when a system-message tripwire is detected.
 */
export class TripwireDetector extends EventEmitter {
  private traceId: string | null = null;
  private detected = false;

  setTraceId(traceId: string) {
    this.traceId = traceId;
    this.detected = false;
  }

  /** Call this from the observability exporter's _exportTracingEvent hook */
  onTracingEvent(event: TracingEvent): void {
    if (this.detected || !this.traceId) return;
    if (event.exportedSpan.traceId !== this.traceId) return;

    // Check for processor span with tripwire
    const span = event.exportedSpan;
    if (span.type !== SpanType.PROCESSOR) return;
    if (!span.output || !isSystemMessageTripwire(span.output)) return;

    this.detected = true;
    const counts = extractTripwireTokenCounts(span.output);
    const errorText = formatSystemMessageTripwireError(counts.systemTokens, counts.limit);
    this.emit('tripwire', errorText);
  }

  clear() {
    this.traceId = null;
    this.detected = false;
    this.removeAllListeners();
  }
}

/** Shared instance for wake-runner to use */
export const tripwireDetector = new TripwireDetector();
