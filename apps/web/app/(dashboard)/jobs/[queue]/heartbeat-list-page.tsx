import { Suspense } from 'react';
import { db, agents } from '@tourbillon/db';
import { desc, eq } from 'drizzle-orm';
import { getActiveCompany } from '@/lib/company';
import { HeartbeatListClient } from './heartbeat-list-client';

async function loadAgentOptions() {
  const company = await getActiveCompany();
  return db
    .select({
      id: agents.id,
      name: agents.name,
      urlKey: agents.urlKey,
      title: agents.title,
    })
    .from(agents)
    .where(eq(agents.companyId, company.id))
    .orderBy(desc(agents.createdAt));
}

function HeartbeatListFallback() {
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">Loading heartbeats…</p>
    </div>
  );
}

export async function HeartbeatListPage() {
  const agentOptions = await loadAgentOptions();

  return (
    <Suspense fallback={<HeartbeatListFallback />}>
      <HeartbeatListClient agents={agentOptions} />
    </Suspense>
  );
}
