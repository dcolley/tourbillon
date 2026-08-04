import { randomUUID } from 'crypto';
import { isMastraTracingEnabled } from '@tourbillon/shared';

/** Mastra / OTEL trace IDs must be 1–32 hexadecimal characters (no hyphens). */
export function createHeartbeatTraceId(): string {
  return randomUUID().replace(/-/g, '');
}

export interface HeartbeatTracingOptionsInput {
  companyId: string;
  agentId: string;
  agentUrlKey: string;
  wakeReason: string;
  heartbeatRunId: string;
  issueId?: string;
  goalId?: string;
  projectId?: string;
  /** When set, reuse this hex trace id (e.g. harness UI events + Phoenix share one id). */
  traceId?: string;
}

/**
 * Shared `tracingOptions` for durable Agent.stream and harness Session.sendMessage.
 * Phoenix/Arize: tags land on the root span as OpenInference tag.tags (filterable);
 * metadata is also exported into the OpenInference metadata JSON blob.
 */
export function buildHeartbeatTracingOptions(
  input: HeartbeatTracingOptionsInput,
):
  | {
      metadata: Record<string, string | undefined>;
      tags: string[];
      requestContextKeys: string[];
      traceId?: string;
    }
  | undefined {
  if (!isMastraTracingEnabled()) return undefined;

  return {
    metadata: {
      issueId: input.issueId,
      goalId: input.goalId,
      projectId: input.projectId,
      heartbeatRunId: input.heartbeatRunId,
      companyId: input.companyId,
      agentId: input.agentId,
      agentUrlKey: input.agentUrlKey,
      wakeReason: input.wakeReason,
    },
    tags: [
      `company:${input.companyId}`,
      `agent:${input.agentUrlKey}`,
      `wake:${input.wakeReason}`,
      ...(input.issueId ? [`issue:${input.issueId}`] : []),
    ],
    requestContextKeys: [
      'runId',
      'agentId',
      'companyId',
      'taskId',
      'goalId',
      'projectId',
      'jobId',
    ],
    ...(input.traceId ? { traceId: input.traceId } : {}),
  };
}
