import { Mastra } from '@mastra/core';
import { Observability, SensitiveDataFilter } from '@mastra/observability';
import { SpanType } from '@mastra/core/observability';
import {
  isObservabilityEnabled,
  shouldStoreModelChunks,
} from '@tourbillon/shared';
import { TourbillonPostgresExporter } from './observability/tourbillon-postgres-exporter';

const globalForMastra = globalThis as unknown as {
  tourbillonMastra?: Mastra;
};

function buildObservability(): Observability | undefined {
  if (!isObservabilityEnabled()) return undefined;

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
        exporters: [new TourbillonPostgresExporter()],
      },
    },
  });
}

export function getMastraInstance(): Mastra {
  if (!globalForMastra.tourbillonMastra) {
    globalForMastra.tourbillonMastra = new Mastra({
      logger: false,
      observability: buildObservability(),
    });
  }
  return globalForMastra.tourbillonMastra;
}

export async function flushObservability(): Promise<void> {
  if (!isObservabilityEnabled()) return;
  const instance = getMastraInstance().observability.getDefaultInstance();
  await instance?.flush();
  const exporter = instance
    ?.getExporters()
    .find((e) => e.name === 'tourbillon-postgres-exporter');
  await exporter?.flush();
}
