'use client';

import { ObservabilityListClient } from '@/components/observability-list-client';

export function HeartbeatObservabilityTab({
  jobId,
  heartbeatRunId,
  agent,
}: {
  jobId: string;
  heartbeatRunId?: string | null;
  agent?: { id: string; name: string } | null;
}) {
  return (
    <ObservabilityListClient
      agents={agent ? [{ id: agent.id, name: agent.name }] : []}
      fixedHeartbeatRunId={heartbeatRunId ?? undefined}
      fixedJobId={heartbeatRunId ? undefined : jobId}
      fixedAgentId={agent?.id}
      showAgentColumn={!agent}
      showPageHeader={false}
    />
  );
}
