import { Suspense } from 'react';
import { db, agents } from '@tourbillon/db';
import { desc, eq } from 'drizzle-orm';
import { listGoalOptions } from '@/lib/goals';
import { listProjectOptions } from '@/lib/projects';
import { getActiveCompany } from '@/lib/company';
import { ObservabilityListClient } from '@/components/observability-list-client';

async function loadFilterOptions() {
  const company = await getActiveCompany();
  const [agentRows, goals, projects] = await Promise.all([
    db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.companyId, company.id))
      .orderBy(desc(agents.createdAt)),
    listGoalOptions(),
    listProjectOptions(),
  ]);
  return { agents: agentRows, goals, projects };
}

function ObservabilityFallback() {
  return (
    <div className="space-y-6 p-6">
      <p className="text-sm text-muted-foreground">Loading observability…</p>
    </div>
  );
}

export default async function ObservabilityPage() {
  const { agents, goals, projects } = await loadFilterOptions();

  return (
    <div className="p-6">
      <Suspense fallback={<ObservabilityFallback />}>
        <ObservabilityListClient agents={agents} goals={goals} projects={projects} />
      </Suspense>
    </div>
  );
}
