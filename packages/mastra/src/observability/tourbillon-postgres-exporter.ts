import {
  TracingEventType,
  type TracingEvent,
} from '@mastra/core/observability';
import { BaseExporter } from '@mastra/observability';
import { db, agentObservabilityEvents } from '@tourbillon/db';
import { isObservabilityEnabled } from '@tourbillon/shared';
import { mapExportedSpanToEvent, shouldPersistTracingEvent } from './map-span';

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_MS = 2000;

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
    if (!shouldPersistTracingEvent(event.type)) return;
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
