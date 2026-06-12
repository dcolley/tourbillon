import { db, agents } from '@tourbillon/db';
import { desc } from 'drizzle-orm';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AgentListRow } from './agent-list-row';

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const allAgents = await db.select().from(agents).orderBy(desc(agents.createdAt));

  return (
    <div className="space-y-6">
      {error ? (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <PageHeader
        title="Agents"
        description="Your AI workforce"
        actions={<Button render={<Link href="/agent/new" />}>+ Hire Agent</Button>}
      />

      <Card>
        <CardContent className="p-0">
          {allAgents.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <p className="mb-2 text-lg font-medium">No agents yet</p>
              <p className="text-sm">Hire your first AI agent to get started.</p>
            </div>
          ) : (
            <div className="divide-y">
              {allAgents.map((agent) => (
                <AgentListRow key={agent.id} agent={agent} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
