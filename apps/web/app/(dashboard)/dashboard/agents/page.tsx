import { db, agents } from '@paperclip-mastra/db';
import { desc } from 'drizzle-orm';
import Link from 'next/link';

export default async function AgentsPage() {
  const allAgents = await db.select().from(agents).orderBy(desc(agents.createdAt));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Agents</h1>
          <p className="text-muted-foreground">Your AI workforce</p>
        </div>
        <Link
          href="/dashboard/agents/new"
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          + Hire Agent
        </Link>
      </div>

      <div className="border rounded-lg divide-y">
        {allAgents.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">
            <p className="text-lg font-medium mb-2">No agents yet</p>
            <p className="text-sm">Hire your first AI agent to get started.</p>
          </div>
        ) : allAgents.map((agent) => (
          <Link
            key={agent.id}
            href={`/dashboard/agents/${agent.id}`}
            className="flex items-center justify-between p-4 hover:bg-accent/50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm">
                {agent.name.charAt(0)}
              </div>
              <div>
                <p className="font-medium">{agent.name}</p>
                <p className="text-sm text-muted-foreground">{agent.title}</p>
              </div>
            </div>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span className="capitalize">{agent.role}</span>
              <AgentStatusBadge status={agent.status} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function AgentStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: 'bg-green-100 text-green-700',
    paused: 'bg-yellow-100 text-yellow-700',
    archived: 'bg-gray-100 text-gray-700',
    pending_approval: 'bg-blue-100 text-blue-700',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? ''}`}>
      {status}
    </span>
  );
}
