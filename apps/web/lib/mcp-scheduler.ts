/**
 * MCP control-plane helpers for tools that call the scheduler.
 *
 * Tool errors from scheduler calls are a fixed message; the detail is logged server-side,
 * redacted. Any other tool error message is also passed through Authorization redaction.
 */
import { triggerAgentHeartbeat } from '@/lib/heartbeat';
import {
  SchedulerRequestError,
  WAKE_IN_FLIGHT_MESSAGE,
  logSchedulerError,
  redactSchedulerErrorDetail,
  wakeSkipMessage,
} from '@/lib/scheduler-errors';

export const MCP_SCHEDULER_ERROR_MESSAGE = 'Scheduler request failed. Try again shortly.';

/** wake_agent: trigger an on-demand heartbeat; errors are fixed messages only. */
export async function wakeAgentForMcp(
  agentId: string,
  companyId: string,
  trigger: typeof triggerAgentHeartbeat = triggerAgentHeartbeat,
) {
  try {
    const result = await trigger(agentId, companyId);
    return {
      runId: result.runId,
      jobId: result.jobId,
      outcome: result.outcome,
      // Fixed client text from the skip code only; never scheduler response text.
      skipReason: result.outcome === 'skipped' ? wakeSkipMessage(result.skipCode) : null,
      skipCode: result.outcome === 'skipped' ? (result.skipCode ?? 'unknown') : null,
    };
  } catch (err) {
    if (err instanceof SchedulerRequestError && err.code === 'wake_in_flight') {
      throw new Error(WAKE_IN_FLIGHT_MESSAGE);
    }
    logSchedulerError('mcp wake_agent', err);
    throw new Error(MCP_SCHEDULER_ERROR_MESSAGE);
  }
}

/** Message for a failed tools/call. Scheduler failures → fixed text; others redacted. */
export function mcpToolErrorMessage(err: unknown): string {
  if (err instanceof SchedulerRequestError) {
    return err.code === 'wake_in_flight' ? WAKE_IN_FLIGHT_MESSAGE : MCP_SCHEDULER_ERROR_MESSAGE;
  }
  if (err instanceof Error) return redactSchedulerErrorDetail(err.message);
  return 'Tool execution failed';
}
