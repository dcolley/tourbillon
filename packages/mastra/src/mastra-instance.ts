import { Agent } from '@mastra/core/agent';
import { PostgresStore } from '@mastra/pg';
import { Mastra } from '@mastra/core';
import { ArizeExporter } from '@mastra/arize';
import { Observability, SensitiveDataFilter } from '@mastra/observability';
import { SpanType, type ObservabilityExporter } from '@mastra/core/observability';
import {
  isObservabilityEnabled,
  isPhoenixCollectorEnabled,
  isMastraTracingEnabled,
  observabilityFlushTimeoutMs,
  phoenixCollectorEndpoint,
  phoenixProjectName,
  shouldStoreModelChunks,
  createTraceLogger,
  flushUnitsSafely,
  sanitizeFlushErrorText,
  type FlushUnit,
} from '@tourbillon/shared';
import { TourbillonPostgresExporter } from './observability/tourbillon-postgres-exporter';
import { SecretValueRedactionProcessor } from './observability/secret-value-redaction';
import { requireDatabaseUrl } from '@tourbillon/db/database-url';

const globalForMastra = globalThis as unknown as {
  tourbillonMastra?: Mastra;
  tourbillonMastraStore?: PostgresStore;
};

const tracer = createTraceLogger('mastra-instance', {});

/**
 * Phoenix/Arize OTLP exporter. The underlying `@mastra/otel-exporter` enables the log
 * signal by default, which derives a `/v1/logs` endpoint from the traces URL — Phoenix
 * has no OTLP log ingest, so every log export there is a 405, and the exporter does
 * not read `OTEL_LOGS_EXPORTER`. Turn the signal off at the source.
 */
export function buildArizeExporter(): ObservabilityExporter {
  return new ArizeExporter({
    endpoint: phoenixCollectorEndpoint(),
    apiKey: process.env.PHOENIX_API_KEY || undefined,
    projectName: phoenixProjectName(),
    signals: { traces: true, logs: false },
  });
}

function buildExporters(): ObservabilityExporter[] {
  const exporters: ObservabilityExporter[] = [];

  if (isObservabilityEnabled()) {
    exporters.push(new TourbillonPostgresExporter());
  }

  if (isPhoenixCollectorEnabled()) {
    exporters.push(buildArizeExporter());
  }

  return exporters;
}

/** #100: known-secret-value scrub runs first, then Mastra's key-name SensitiveDataFilter. */
export function buildSpanOutputProcessors() {
  return [new SecretValueRedactionProcessor(), new SensitiveDataFilter()];
}

function buildObservability(): Observability | undefined {
  if (!isMastraTracingEnabled()) return undefined;

  const exporters = buildExporters();
  if (exporters.length === 0) return undefined;

  const excludeSpanTypes = shouldStoreModelChunks()
    ? undefined
    : [SpanType.MODEL_CHUNK];

  return new Observability({
    configs: {
      default: {
        serviceName: 'tourbillon',
        requestContextKeys: [
          'runId',
          'agentId',
          'companyId',
          'taskId',
          'goalId',
          'projectId',
          'jobId',
        ],
        excludeSpanTypes,
        spanOutputProcessors: buildSpanOutputProcessors(),
        exporters,
      },
    },
  });
}

function getMastraStorage(): PostgresStore {
  if (!globalForMastra.tourbillonMastraStore) {
    const connectionString = requireDatabaseUrl('Mastra schedule storage');
    globalForMastra.tourbillonMastraStore = new PostgresStore({
      id: 'tourbillon-mastra',
      connectionString,
    });
  }
  return globalForMastra.tourbillonMastraStore;
}

/**
 * Placeholder agents satisfy mastra.schedules target checks.
 * Real Tourbillon generation always runs via WakeRunner in schedules.prepare (returns null).
 */
function ensurePlaceholderAgent(mastra: Mastra, agentId: string, name?: string): void {
  try {
    mastra.getAgentById(agentId);
    return;
  } catch {
    // not registered
  }
  const placeholder = new Agent({
    id: agentId,
    name: name ?? agentId,
    instructions: 'Tourbillon schedule placeholder — WakeRunner handles execution.',
    model: 'openai/gpt-4o-mini',
  });
  mastra.addAgent(placeholder, agentId);
}

export type ScheduleWakeInvoker = (input: {
  agentId: string;
  companyId: string;
  wakeReason: 'timer' | 'assignment' | 'automation';
  taskId?: string;
  metadata?: Record<string, unknown>;
}) => Promise<void>;

let scheduleWakeInvoker: ScheduleWakeInvoker | null = null;

/** Scheduler process registers WakeRunner-backed invoker so prepare can fire wakes. */
export function setScheduleWakeInvoker(invoker: ScheduleWakeInvoker): void {
  scheduleWakeInvoker = invoker;
}

export function getMastraInstance(): Mastra {
  if (!globalForMastra.tourbillonMastra) {
    globalForMastra.tourbillonMastra = new Mastra({
      logger: false,
      storage: getMastraStorage(),
      observability: buildObservability(),
      schedules: {
        prepare: async ({ agentId, schedule }) => {
          const meta = (schedule.metadata ?? {}) as Record<string, unknown>;
          const kind = meta.tourbillonKind as string | undefined;
          const companyId = meta.companyId as string | undefined;

          if (!scheduleWakeInvoker || !companyId) {
            tracer.warn('schedule prepare: no wake invoker or companyId', { agentId, kind });
            return null;
          }

          if (kind === 'agent-timer') {
            await scheduleWakeInvoker({
              agentId,
              companyId,
              wakeReason: 'timer',
              metadata: meta,
            });
            return null;
          }

          if (kind === 'routine') {
            // Routines create issues in their own prepare path via invoker metadata.
            await scheduleWakeInvoker({
              agentId,
              companyId,
              wakeReason: 'assignment',
              metadata: meta,
            });
            return null;
          }

          tracer.warn('schedule prepare: unknown tourbillonKind', { agentId, kind });
          return null;
        },
        onError: async ({ agentId, phase, error }) => {
          tracer.error('schedule error', {
            agentId,
            phase,
            error: error.message,
          });
        },
      },
    });
  }
  return globalForMastra.tourbillonMastra;
}

/** Ensure Mastra storage tables exist (schedules domain). Call once from scheduler boot. */
export async function initMastraStorage(): Promise<void> {
  const store = getMastraStorage();
  await store.init();
  // Construct singleton; scheduling workers start in bootMastraSchedules via startWorkers().
  getMastraInstance();
  tracer.info('Mastra storage initialized');
}

export function ensureMastraAgentRegistered(agentId: string, name?: string): void {
  ensurePlaceholderAgent(getMastraInstance(), agentId, name);
}

/**
 * Flush pending spans/logs to every registered exporter. Always resolves: a collector
 * that is down, rejecting, or hung must never fail the heartbeat that called it.
 * Each unit is flushed independently under OBSERVABILITY_FLUSH_TIMEOUT_MS; failures
 * are logged as warnings with credential-free error text.
 */
export async function flushObservability(): Promise<void> {
  if (!isMastraTracingEnabled()) return;

  let instance: ReturnType<Mastra['observability']['getDefaultInstance']> | undefined;
  try {
    instance = getMastraInstance().observability.getDefaultInstance();
  } catch (err) {
    tracer.warn('observability flush skipped: Mastra instance unavailable', {
      error: sanitizeFlushErrorText(err),
    });
    return;
  }
  if (!instance) return;

  const units: FlushUnit[] = [
    { label: 'observability-instance', flush: () => instance!.flush() },
    ...(instance.getExporters() ?? []).map((exporter, i) => ({
      label: `exporter:${(exporter as { name?: string })?.name || i}`,
      flush: () => exporter.flush(),
    })),
  ];

  await flushUnitsSafely(units, {
    timeoutMs: observabilityFlushTimeoutMs(),
    warn: (message) => tracer.warn(message),
  });
}
