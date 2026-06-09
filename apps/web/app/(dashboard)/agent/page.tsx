import { db, agents } from '@tourbillon/db';
import { desc } from 'drizzle-orm';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/lib/status-badges';

export default async function AgentsPage() {
  const allAgents = await db.select().from(agents).orderBy(desc(agents.createdAt));

  return (
    <div className="space-y-6">
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
                <Link
                  key={agent.id}
                  href={`/agent/${agent.urlKey}`}
                  className="flex items-center justify-between p-4 transition-colors hover:bg-muted/50"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                      {agent.name.charAt(0)}
                    </div>
                    <div>
                      <p className="font-medium">{agent.name}</p>
                      <p className="text-sm text-muted-foreground">{agent.title}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <span className="capitalize">{agent.role}</span>
                    <StatusBadge status={agent.status} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
