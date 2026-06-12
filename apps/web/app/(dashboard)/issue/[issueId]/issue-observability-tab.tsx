'use client';

import { ObservabilityListClient } from '@/components/observability-list-client';

interface AgentOption {
  id: string;
  name: string;
}

export function IssueObservabilityTab({
  issueId,
  agents,
}: {
  issueId: string;
  agents: AgentOption[];
}) {
  return (
    <ObservabilityListClient
      agents={agents}
      fixedIssueId={issueId}
      showIssueColumn={false}
      showPageHeader={false}
    />
  );
}
