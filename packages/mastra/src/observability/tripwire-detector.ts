import { EventEmitter } from 'events';
import type { TracingEvent } from '@mastra/core/observability';
import { SpanType } from '@mastra/core/observability';
import {
  isSystemMessageTripwire,
  isTokenLimiterTripwireInSpan,
  extractTripwireTokenCounts,
  formatSystemMessageTripwireError,
} from '@tourbillon/shared';

/** Extract heartbeatRunId from span (matches production extractContext logic) */
function extractHeartbeatRunId(span: any): string | undefined {
  const ctx = span.requestContext;
  const meta = (span.metadata ?? {}) as Record<string, unknown>;
  
  // Check requestContext runId first
  if (ctx && typeof ctx === 'object') {
    if ('get' in ctx && typeof (ctx as any).get === 'function') {
      const runId = (ctx as any).get('runId');
      if (typeof runId === 'string' && runId.length > 0) return runId;
    }
    const runId = (ctx as Record<string, unknown>).runId;
    if (typeof runId === 'string' && runId.length > 0) return runId;
  }
  
  // Fall back to metadata
  if (typeof meta.heartbeatRunId === 'string' && meta.heartbeatRunId.length > 0) {
    return meta.heartbeatRunId;
  }
  if (typeof meta.runId === 'string' && meta.runId.length > 0) {
    return meta.runId;
  }
  
  return undefined;
}

/**
 * Per-wake tripwire detector. Listens to processor span events and emits
 * 'tripwire' when a TokenLimiter tripwire is detected for this wake's runId.
 * 
 * Detects ANY TokenLimiter tripwire (not just system-messages-alone) that means
 * the model cannot continue. Mastra 1.63+ logs tripwires in output with span status ok,
 * so we check output.tripwire / output.reason even when status is not error.
 * 
 * Filters spans by heartbeatRunId from construction (no "accept any" fallback).
 * This prevents concurrent wakes from colliding on early processor spans.
 * 
 * Stores errorText so wake-runner can check if tripwire fired during stream/observe
 * even if no listener was attached yet.
 */
export class TripwireDetector extends EventEmitter {
  private heartbeatRunId: string;
  private traceId: string | null = null;
  private fired = false;
  private errorText: string | null = null;

  constructor(heartbeatRunId: string) {
    super();
    this.heartbeatRunId = heartbeatRunId;
  }

  setTraceId(traceId: string) {
    this.traceId = traceId;
  }

  /** Called by exporter for each tracing event */
  onTracingEvent(event: TracingEvent): void {
    if (this.fired) return;

    const span = event.exportedSpan;
    
    // Filter by heartbeatRunId first (fail closed - no "accept any")
    const spanRunId = extractHeartbeatRunId(span);
    if (!spanRunId || spanRunId !== this.heartbeatRunId) return;
    
    // If we have a traceId, also filter by it
    if (this.traceId && span.traceId !== this.traceId) return;

    // Check for TokenLimiter tripwire in output (span type agnostic)
    // Mastra 1.63+: appears in MODEL_STEP output with status ok
    // Earlier versions or tests: may appear in PROCESSOR output
    // Detects ANY TokenLimiter tripwire, not just system-messages-alone
    if (!span.output || !isTokenLimiterTripwireInSpan(span.output)) return;

    // Tripwire detected - fire once and store errorText
    this.fired = true;
    const counts = extractTripwireTokenCounts(span.output);
    
    // Format error text: prefer system-message-alone format when detected,
    // otherwise generic TokenLimiter error with any available counts
    if (isSystemMessageTripwire(span.output)) {
      this.errorText = formatSystemMessageTripwireError(counts.systemTokens, counts.limit);
    } else {
      // Generic TokenLimiter tripwire
      const outputStr = typeof span.output === 'string' ? span.output : JSON.stringify(span.output);
      const reasonMatch = outputStr.match(/reason['":\s]+([^"'}]+)/i);
      const tripwireMatch = outputStr.match(/tripwire['":\s]+([^"'}]+)/i);
      const rawMessage = reasonMatch?.[1] || tripwireMatch?.[1] || 'TokenLimiter tripwire';
      
      if (counts.systemTokens !== undefined && counts.limit !== undefined) {
        this.errorText = `${rawMessage} (${counts.systemTokens} tokens, limit ${counts.limit})`;
      } else if (counts.systemTokens !== undefined) {
        this.errorText = `${rawMessage} (${counts.systemTokens} tokens)`;
      } else if (counts.limit !== undefined) {
        this.errorText = `${rawMessage} (limit ${counts.limit})`;
      } else {
        this.errorText = rawMessage;
      }
    }
    
    this.emit('tripwire', this.errorText);
  }

  /** Check if tripwire already fired (for checking after stream/observe returns) */
  getErrorText(): string | null {
    return this.errorText;
  }

  clear() {
    this.fired = false;
    this.traceId = null;
    this.errorText = null;
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
