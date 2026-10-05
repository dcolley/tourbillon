import { db } from './client';
import { agentObservabilityEvents } from './schema/agent-observability-events';
import { eq, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

/**
 * Check if a heartbeat run was truncated due to hitting maxOutputTokens.
 * Returns the finishReason and error text if truncation is detected.
 */
export async function detectTruncatedGeneration(
  heartbeatRunId: string
): Promise<{ truncated: true; finishReason: string; errorText: string } | { truncated: false }> {
  // Query for model_inference events with finishReason in the payload
  const events = await db
    .select({
      eventType: agentObservabilityEvents.eventType,
      payload: agentObservabilityEvents.payload,
      status: agentObservabilityEvents.status,
      errorText: agentObservabilityEvents.errorText,
    })
    .from(agentObservabilityEvents)
    .where(
      and(
        eq(agentObservabilityEvents.heartbeatRunId, heartbeatRunId),
        eq(agentObservabilityEvents.eventType, 'model_inference')
      )
    )
    .orderBy(agentObservabilityEvents.occurredAt);

  for (const event of events) {
    const payload = event.payload as Record<string, unknown> | null;
    const attributes = payload?.attributes as Record<string, unknown> | undefined;
    const finishReason = attributes?.finishReason;

    if (finishReason === 'length') {
      const errorText =
        event.errorText ??
        'Generation truncated: hit output token limit (finishReason: length)';
      return { truncated: true, finishReason: 'length', errorText };
    }
  }

  return { truncated: false };
}
