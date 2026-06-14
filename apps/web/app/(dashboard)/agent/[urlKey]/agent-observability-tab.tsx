'use client';

import { ObservabilityListClient } from '@/components/observability-list-client';

interface GoalOption {
  id: string;
  title: string;
}

interface ProjectOption {
  id: string;
  title: string;
}

export function AgentObservabilityTab({
  agentId,
  agentName,
  goals = [],
  projects = [],
}: {
  agentId: string;
  agentName: string;
  goals?: GoalOption[];
  projects?: ProjectOption[];
}) {
  return (
    <ObservabilityListClient
      agents={[{ id: agentId, name: agentName }]}
      goals={goals}
      projects={projects}
      fixedAgentId={agentId}
      showAgentColumn={false}
      showPageHeader={false}
    />
  );
}
