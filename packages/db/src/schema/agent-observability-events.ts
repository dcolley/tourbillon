import { pgTable, text, timestamp, integer, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies } from './companies';
import { agents } from './agents';
import { createId } from '../utils';

export type ObservabilityEventType =
  | 'agent_run'
  | 'model_generation'
  | 'model_step'
  | 'model_inference'
  | 'model_chunk'
  | 'tool_call'
  | 'mcp_tool_call'
  | 'generic'
  | 'text_delta'
  | 'tool_call_start'
  | 'tool_call_result'
  | 'tool_suspended'
  | 'tool_approval_required'
  | 'subagent_spawn'
  | 'subagent_done'
  | 'subagent_start'
  | 'subagent_end'
  | 'om_observation'
  | 'om_reflection'
  | 'agent_done'
  | 'usage_update'
  | 'mode_switch'
  | 'error';

export type ObservabilityEventStatus = 'ok' | 'error';

export const agentObservabilityEvents = pgTable(
  'agent_observability_events',
  {
    id: text('id').primaryKey().$defaultFn(createId),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    traceId: text('trace_id').notNull(),
    spanId: text('span_id').notNull(),
    parentSpanId: text('parent_span_id'),
    heartbeatRunId: text('heartbeat_run_id'),
    jobId: text('job_id'),
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    issueId: text('issue_id'),
    projectId: text('project_id'),
    goalId: text('goal_id'),
    eventType: text('event_type').$type<ObservabilityEventType>().notNull(),
    name: text('name').notNull(),
    status: text('status').$type<ObservabilityEventStatus>().notNull().default('ok'),
    model: text('model'),
    toolId: text('tool_id'),
    inputPreview: text('input_preview'),
    outputPreview: text('output_preview'),
    payload: jsonb('payload').default({}),
    errorText: text('error_text'),
    durationMs: integer('duration_ms'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    startedAt: timestamp('started_at'),
    occurredAt: timestamp('occurred_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('agent_observability_events_trace_span_uidx').on(table.traceId, table.spanId),
    index('agent_observability_events_company_occurred_idx').on(
      table.companyId,
      table.occurredAt
    ),
    index('agent_observability_events_company_issue_occurred_idx')
      .on(table.companyId, table.issueId, table.occurredAt)
      .where(sql`${table.issueId} IS NOT NULL`),
    index('agent_observability_events_company_project_occurred_idx')
      .on(table.companyId, table.projectId, table.occurredAt)
      .where(sql`${table.projectId} IS NOT NULL`),
    index('agent_observability_events_company_goal_occurred_idx')
      .on(table.companyId, table.goalId, table.occurredAt)
      .where(sql`${table.goalId} IS NOT NULL`),
    index('agent_observability_events_company_agent_occurred_idx').on(
      table.companyId,
      table.agentId,
      table.occurredAt
    ),
    index('agent_observability_events_company_type_occurred_idx').on(
      table.companyId,
      table.eventType,
      table.occurredAt
    ),
    index('agent_observability_events_trace_idx').on(table.traceId),
    index('agent_observability_events_heartbeat_run_idx')
      .on(table.heartbeatRunId)
      .where(sql`${table.heartbeatRunId} IS NOT NULL`),
  ]
);

export type AgentObservabilityEvent = typeof agentObservabilityEvents.$inferSelect;
export type NewAgentObservabilityEvent = typeof agentObservabilityEvents.$inferInsert;
