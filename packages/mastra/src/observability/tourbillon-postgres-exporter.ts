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
import { consumeApiErrorDetails } from './error-details-registry';

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
 * Enrich span.errorInfo with AI_APICallError fields from the error details registry.
 * Mastra only copies message/name/stack; we need statusCode/url/responseBody/data for diagnostics.
 * 
 * Lookup is by runId from span metadata, which the fetch wrapper populates via AsyncLocalStorage.
 */
function enrichSpanErrorInfo(span: AnyExportedSpan): void {
  if (!span.errorInfo) return;
  
  const { consumeApiErrorDetails } = require('./error-details-registry') as typeof import('./error-details-registry');

  // Extract runId from span metadata (Mastra always includes this)
  const runId = extractHeartbeatRunId(span);
  if (!runId) return;

  // Consume error details stored by fetch wrapper using runId from AsyncLocalStorage
  const details = consumeApiErrorDetails(runId);
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
  
  // Cache companyId by traceId to handle nested spans without companyId
  private traceCompanyIdCache = new Map<string, string>();

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
    
    const span = event.exportedSpan;
    
    // Try to get companyId from span or cache
    let companyIdFromSpan: string | undefined;
    const ctx = span.requestContext;
    const meta = (span.metadata ?? {}) as Record<string, unknown>;
    
    if (ctx && typeof ctx === 'object') {
      if ('get' in ctx && typeof (ctx as { get: unknown }).get === 'function') {
        const id = (ctx as { get: (k: string) => unknown }).get('companyId');
        if (typeof id === 'string' && id.length > 0) companyIdFromSpan = id;
      }
      if (!companyIdFromSpan) {
        const id = (ctx as Record<string, unknown>).companyId;
        if (typeof id === 'string' && id.length > 0) companyIdFromSpan = id;
      }
    }
    if (!companyIdFromSpan && typeof meta.companyId === 'string' && meta.companyId.length > 0) {
      companyIdFromSpan = meta.companyId;
    }
    
    // Cache companyId for this trace
    if (companyIdFromSpan && span.traceId) {
      this.traceCompanyIdCache.set(span.traceId, companyIdFromSpan);
    }
    
    // If span is missing companyId but we have it cached for this trace, inject it
    if (!companyIdFromSpan && span.traceId) {
      const cachedCompanyId = this.traceCompanyIdCache.get(span.traceId);
      if (cachedCompanyId) {
        // Inject companyId into span metadata so mapExportedSpanToEvent can find it
        const metadata = (span.metadata ?? {}) as Record<string, unknown>;
        span.metadata = { ...metadata, companyId: cachedCompanyId };
      }
    }
    
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
    
    // Clean up trace cache if it gets too large (keep last 1000 traces)
    if (this.traceCompanyIdCache.size > 1000) {
      const entries = Array.from(this.traceCompanyIdCache.entries());
      this.traceCompanyIdCache.clear();
      // Keep last 500 entries
      for (const [traceId, companyId] of entries.slice(-500)) {
        this.traceCompanyIdCache.set(traceId, companyId);
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.flush();
    this.traceCompanyIdCache.clear();
    await super.shutdown();
  }
}
