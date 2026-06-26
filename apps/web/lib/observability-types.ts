import {
  OBSERVABILITY_EVENT_STATUSES,
  OBSERVABILITY_EVENT_TYPES,
  type ObservabilityEventStatus,
  type ObservabilityEventType,
} from '@tourbillon/shared/observability';

export type { ObservabilityEventStatus, ObservabilityEventType };

export interface ObservabilityEventRow {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  heartbeatRunId: string | null;
  jobId: string | null;
  agentId: string | null;
  agentName: string | null;
  issueId: string | null;
  projectId: string | null;
  goalId: string | null;
  eventType: ObservabilityEventType;
  name: string;
  status: ObservabilityEventStatus;
  model: string | null;
  toolId: string | null;
  inputPreview: string | null;
  outputPreview: string | null;
  payload: Record<string, unknown>;
  errorText: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  startedAt: string | null;
  occurredAt: string;
}

export interface ListObservabilityEventsInput {
  companyId: string;
  issueId?: string;
  projectId?: string;
  goalId?: string;
  agentId?: string;
  eventType?: ObservabilityEventType;
  status?: ObservabilityEventStatus;
  traceId?: string;
  heartbeatRunId?: string;
  jobId?: string;
  from?: Date;
  to?: Date;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface ListObservabilityEventsResult {
  events: ObservabilityEventRow[];
  total: number;
  page: number;
  pageSize: number;
}

export const OBSERVABILITY_PAGE_SIZES = [25, 50, 100] as const;
export type ObservabilityPageSize = (typeof OBSERVABILITY_PAGE_SIZES)[number];

export function isObservabilityPageSize(value: number): value is ObservabilityPageSize {
  return OBSERVABILITY_PAGE_SIZES.includes(value as ObservabilityPageSize);
}

export function isObservabilityEventType(value: string): value is ObservabilityEventType {
  return (OBSERVABILITY_EVENT_TYPES as readonly string[]).includes(value);
}

export function isObservabilityEventStatus(value: string): value is ObservabilityEventStatus {
  return (OBSERVABILITY_EVENT_STATUSES as readonly string[]).includes(value);
}
