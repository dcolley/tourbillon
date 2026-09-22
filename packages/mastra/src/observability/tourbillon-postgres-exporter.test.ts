import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import type { AnyExportedSpan, TracingEvent } from '@mastra/core/observability';
import { TracingEventType } from '@mastra/core/observability';
import { TourbillonPostgresExporter } from './tourbillon-postgres-exporter';

describe('TourbillonPostgresExporter companyId inheritance', () => {
  let exporter: TourbillonPostgresExporter;

  beforeEach(() => {
    exporter = new TourbillonPostgresExporter();
  });

  afterEach(async () => {
    await exporter.shutdown();
  });

  function createTracingEvent(span: Partial<AnyExportedSpan>): TracingEvent {
    return {
      type: TracingEventType.SPAN_ENDED,
      exportedSpan: {
        id: 'span-1',
        traceId: 'trace-1',
        type: 'memory_operation' as any,
        name: 'test',
        startTime: new Date(),
        endTime: new Date(),
        ...span,
      } as AnyExportedSpan,
    };
  }

  it('caches companyId from first span in trace', async () => {
    const rootSpan = createTracingEvent({
      id: 'root-span',
      traceId: 'trace-abc',
      metadata: {
        companyId: 'company-123',
      },
    });

    // Process root span (should cache companyId)
    await exporter['_exportTracingEvent'](rootSpan);

    // Verify cache has the companyId
    const cached = exporter['traceCompanyIdCache'].get('trace-abc');
    assert.equal(cached, 'company-123', 'companyId should be cached by traceId');
  });

  it('injects cached companyId into child span without companyId', async () => {
    // First, process a root span with companyId
    const rootSpan = createTracingEvent({
      id: 'root-span',
      traceId: 'trace-xyz',
      metadata: {
        companyId: 'company-456',
        heartbeatRunId: 'run-1',
      },
    });
    await exporter['_exportTracingEvent'](rootSpan);

    // Then, process a child span without companyId
    const childSpan = createTracingEvent({
      id: 'child-span',
      traceId: 'trace-xyz',
      parentSpanId: 'root-span',
      name: 'observation',
      metadata: {
        // No companyId here - should be inherited from cache
        heartbeatRunId: 'run-1',
        observation: true,
      },
    });

    await exporter['_exportTracingEvent'](childSpan);

    // Verify that companyId was injected into the span's metadata
    const spanMeta = childSpan.exportedSpan.metadata as Record<string, unknown>;
    assert.equal(
      spanMeta.companyId,
      'company-456',
      'Child span should have inherited companyId from cache'
    );
  });

  it('does not override existing companyId in span', async () => {
    // Cache a companyId
    const rootSpan = createTracingEvent({
      id: 'root-span',
      traceId: 'trace-def',
      metadata: {
        companyId: 'company-111',
      },
    });
    await exporter['_exportTracingEvent'](rootSpan);

    // Process a child with different companyId
    const childSpan = createTracingEvent({
      id: 'child-span',
      traceId: 'trace-def',
      parentSpanId: 'root-span',
      metadata: {
        companyId: 'company-222',
        heartbeatRunId: 'run-2',
      },
    });

    await exporter['_exportTracingEvent'](childSpan);

    // Verify original companyId is preserved
    const spanMeta = childSpan.exportedSpan.metadata as Record<string, unknown>;
    assert.equal(
      spanMeta.companyId,
      'company-222',
      'Existing companyId should not be overridden'
    );
  });

  it('clears trace cache when it grows too large', async () => {
    // Fill cache with 1001 traces (over the 1000 limit)
    for (let i = 0; i < 1001; i++) {
      const span = createTracingEvent({
        id: `span-${i}`,
        traceId: `trace-${i}`,
        metadata: {
          companyId: `company-${i}`,
        },
      });
      await exporter['_exportTracingEvent'](span);
    }

    // Force a flush to trigger cache cleanup
    await exporter.flush();

    // Cache should be reduced to 500 entries
    const cacheSize = exporter['traceCompanyIdCache'].size;
    assert.ok(
      cacheSize <= 500,
      `Cache should be reduced to 500 or fewer entries, got ${cacheSize}`
    );

    // Verify that recent entries are retained
    assert.equal(
      exporter['traceCompanyIdCache'].get('trace-1000'),
      'company-1000',
      'Most recent entries should be retained'
    );
  });

  it('clears cache on shutdown', async () => {
    // Add some entries
    const span = createTracingEvent({
      id: 'span-1',
      traceId: 'trace-shutdown',
      metadata: {
        companyId: 'company-shutdown',
      },
    });
    await exporter['_exportTracingEvent'](span);

    assert.ok(
      exporter['traceCompanyIdCache'].size > 0,
      'Cache should have entries before shutdown'
    );

    // Shutdown
    await exporter.shutdown();

    // Verify cache is cleared
    assert.equal(
      exporter['traceCompanyIdCache'].size,
      0,
      'Cache should be empty after shutdown'
    );
  });
});

describe('TourbillonPostgresExporter OM span handling', () => {
  let exporter: TourbillonPostgresExporter;

  beforeEach(() => {
    exporter = new TourbillonPostgresExporter();
  });

  afterEach(async () => {
    await exporter.shutdown();
  });

  function createTracingEvent(span: Partial<AnyExportedSpan>): TracingEvent {
    return {
      type: TracingEventType.SPAN_ENDED,
      exportedSpan: {
        id: 'span-1',
        traceId: 'trace-1',
        type: 'memory_operation' as any,
        name: 'test',
        startTime: new Date(),
        endTime: new Date(),
        metadata: {
          companyId: 'company-1',
        },
        ...span,
      } as AnyExportedSpan,
    };
  }

  it('processes OM observation span with companyId inheritance', async () => {
    // Root span with companyId
    const rootSpan = createTracingEvent({
      id: 'root-1',
      traceId: 'trace-om-1',
      type: 'agent_run' as any,
      name: 'agent-run',
      metadata: {
        companyId: 'company-om-1',
        heartbeatRunId: 'run-om-1',
      },
    });
    await exporter['_exportTracingEvent'](rootSpan);

    // OM observation span without companyId
    const omSpan = createTracingEvent({
      id: 'om-obs-1',
      traceId: 'trace-om-1',
      parentSpanId: 'root-1',
      type: 'memory_operation' as any,
      name: 'Observation',
      metadata: {
        // No companyId - should inherit
        heartbeatRunId: 'run-om-1',
        observation: true,
      },
      attributes: {
        usage: {
          promptTokens: 706,
          completionTokens: 116,
        },
      },
    });

    await exporter['_exportTracingEvent'](omSpan);

    // Verify companyId was injected
    const spanMeta = omSpan.exportedSpan.metadata as Record<string, unknown>;
    assert.equal(
      spanMeta.companyId,
      'company-om-1',
      'OM span should inherit companyId'
    );
  });

  it('processes OM reflection span with companyId inheritance', async () => {
    // Root span with companyId
    const rootSpan = createTracingEvent({
      id: 'root-2',
      traceId: 'trace-om-2',
      type: 'agent_run' as any,
      name: 'agent-run',
      metadata: {
        companyId: 'company-om-2',
        heartbeatRunId: 'run-om-2',
      },
    });
    await exporter['_exportTracingEvent'](rootSpan);

    // OM reflection span without companyId
    const omSpan = createTracingEvent({
      id: 'om-refl-1',
      traceId: 'trace-om-2',
      parentSpanId: 'root-2',
      type: 'memory_operation' as any,
      name: 'Reflection',
      metadata: {
        // No companyId - should inherit
        heartbeatRunId: 'run-om-2',
        reflection: true,
      },
      attributes: {
        usage: {
          promptTokens: 1200,
          completionTokens: 639,
        },
      },
    });

    await exporter['_exportTracingEvent'](omSpan);

    // Verify companyId was injected
    const spanMeta = omSpan.exportedSpan.metadata as Record<string, unknown>;
    assert.equal(
      spanMeta.companyId,
      'company-om-2',
      'OM reflection span should inherit companyId'
    );
  });
});
