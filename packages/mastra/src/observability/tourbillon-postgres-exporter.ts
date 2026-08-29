import {
  TracingEventType,
  type TracingEvent,
  type AnyExportedSpan,
} from '@mastra/core/observability';
import { BaseExporter } from '@mastra/observability';
import { db, agentObservabilityEvents } from '@tourbillon/db';
import { isObservabilityEnabled } from '@tourbillon/shared';
import { mapExportedSpanToEvent, shouldPersistTracingEvent } from './map-span';
import { tripwireDetectorRegistry } from './tripwire-detector';
import { consumeApiErrorDetails, consumeApiErrorDetailsByRequestKey } from './error-details-registry';

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_MS = 2000;

/**
 * Extract heartbeat runId from span metadata or requestContext.
 */
function extractHeartbeatRunId(span: AnyExportedSpan): string | undefined {
  const meta = span.metadata as Record<string, unknown> | undefined;
  if (meta?.heartbeatRunId && typeof meta.heartbeatRunId === 'string') {
    return meta.heartbeatRunId;
  }
  
  const ctx = span.requestContext;
  if (ctx && typeof ctx === 'object') {
    if ('get' in ctx && typeof (ctx as { get: unknown }).get === 'function') {
      const runId = (ctx as { get: (k: string) => unknown }).get('runId');
      if (typeof runId === 'string') return runId;
    }
    const runId = (ctx as Record<string, unknown>).runId;
    if (typeof runId === 'string') return runId;
  }
  
  return undefined;
}

/**
 * Extract first frame request key from span.errorInfo.
 */
function extractRequestKeyFromError(span: AnyExportedSpan): string | undefined {
  const errorInfo = span.errorInfo as { __firstFrameRequestKey?: unknown } | undefined;
  if (errorInfo && typeof errorInfo.__firstFrameRequestKey === 'string') {
    return errorInfo.__firstFrameRequestKey;
  }
  return undefined;
}

/**
 * Enrich span.errorInfo with AI_APICallError fields from the error details registry.
 * Mastra only copies message/name/stack; we need statusCode/url/responseBody/data for diagnostics.
 * 
 * Tries lookup by requestKey first (stored by fetch wrapper BEFORE SPAN_ENDED),
 * then falls back to runId (if stored by wake-runner catch).
 */
function enrichSpanErrorInfo(span: AnyExportedSpan): void {
  if (!span.errorInfo) return;
  
  // Try requestKey first (the primary path - stored BEFORE SPAN_ENDED)
  const requestKey = extractRequestKeyFromError(span);
  let details = requestKey ? consumeApiErrorDetailsByRequestKey(requestKey) : undefined;
  
  // Fall back to runId lookup (legacy path)
  if (!details) {
    const runId = extractHeartbeatRunId(span);
    details = runId ? consumeApiErrorDetails(runId) : undefined;
  }
  
  if (!details) return;
  
  // Mutate errorInfo to add the AI_APICallError fields
  const errorInfo = span.errorInfo as unknown as Record<string, unknown>;
  
  if (details.statusCode !== undefined) {
    errorInfo.statusCode = details.statusCode;
  }
  if (details.url !== undefined) {
    errorInfo.url = details.url;
  }
  if (details.responseBody !== undefined) {
    errorInfo.responseBody = details.responseBody;
  }
  if (details.data !== undefined) {
    errorInfo.data = details.data;
  }
  if (details.firstFrameRequestKey !== undefined) {
    errorInfo.__firstFrameRequestKey = details.firstFrameRequestKey;
  }
}

export class TourbillonPostgresExporter extends BaseExporter {
  name = 'tourbillon-postgres-exporter';

  private buffer: ReturnType<typeof mapExportedSpanToEvent>[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;

  constructor() {
    super();
    if (!isObservabilityEnabled()) {
      this.setDisabled('OBSERVABILITY_ENABLED is not true', 'debug');
    }
  }

  protected async _exportTracingEvent(event: TracingEvent): Promise<void> {
    // Notify all active detectors first (before batching)
    tripwireDetectorRegistry.onTracingEvent(event);
    
    if (!shouldPersistTracingEvent(event.type)) return;
    
    // Enrich span.errorInfo with AI_APICallError fields before mapping
    // (Mastra only copies message/name/stack; we need statusCode/url/responseBody/data)
    enrichSpanErrorInfo(event.exportedSpan);
    
    const row = mapExportedSpanToEvent(event.exportedSpan);
    if (!row) return;

    this.buffer.push(row);

    if (this.buffer.length >= DEFAULT_BATCH_SIZE) {
      await this.flush();
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, DEFAULT_FLUSH_MS);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      return;
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0, this.buffer.length);

    this.flushing = (async () => {
      try {
        await db
          .insert(agentObservabilityEvents)
          .values(batch.filter((row): row is NonNullable<typeof row> => row !== null))
          .onConflictDoNothing({
            target: [agentObservabilityEvents.traceId, agentObservabilityEvents.spanId],
          });
      } catch (err) {
        console.error('[tourbillon-postgres-exporter] flush failed', err);
      } finally {
        this.flushing = null;
      }
    })();

    await this.flushing;
  }

  async shutdown(): Promise<void> {
    await this.flush();
    await super.shutdown();
  }
}
