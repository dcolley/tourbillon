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
  phoenixCollectorEndpoint,
  phoenixProjectName,
  shouldStoreModelChunks,
  createTraceLogger,
} from '@tourbillon/shared';
import { TourbillonPostgresExporter } from './observability/tourbillon-postgres-exporter';

const globalForMastra = globalThis as unknown as {
  tourbillonMastra?: Mastra;
  tourbillonMastraStore?: PostgresStore;
};

const tracer = createTraceLogger('mastra-instance', {});

function buildExporters(): ObservabilityExporter[] {
  const exporters: ObservabilityExporter[] = [];

  if (isObservabilityEnabled()) {
    exporters.push(new TourbillonPostgresExporter());
  }

  if (isPhoenixCollectorEnabled()) {
    exporters.push(
      new ArizeExporter({
        endpoint: phoenixCollectorEndpoint(),
        apiKey: process.env.PHOENIX_API_KEY || undefined,
        projectName: phoenixProjectName(),
      }),
    );
  }

  return exporters;
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
        spanOutputProcessors: [new SensitiveDataFilter()],
        exporters,
      },
    },
  });
}

function getMastraStorage(): PostgresStore {
  if (!globalForMastra.tourbillonMastraStore) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required for Mastra schedule storage');
    }
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

export async function flushObservability(): Promise<void> {
  if (!isMastraTracingEnabled()) return;
  const instance = getMastraInstance().observability.getDefaultInstance();
  await instance?.flush();
  const exporters = instance?.getExporters() ?? [];
  await Promise.all(exporters.map((exporter) => exporter.flush()));
}
