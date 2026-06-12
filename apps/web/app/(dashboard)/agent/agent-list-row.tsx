import Link from 'next/link';
import type { Agent } from '@tourbillon/db';
import type { AgentRuntimeConfig } from '@tourbillon/shared';
import { Badge } from '@/components/ui/badge';
import { getAgentHeartbeatSummary } from '@/lib/agent-heartbeat-summary';
import { StatusBadge } from '@/lib/status-badges';
import { toggleAgentActiveAction } from './actions';

export function AgentListRow({ agent }: { agent: Agent }) {
  const heartbeat = getAgentHeartbeatSummary(agent.runtimeConfig as AgentRuntimeConfig);
  const isActive = agent.status === 'active';
  const canToggle = agent.status !== 'pending_approval';

  return (
    <div className="flex items-center justify-between gap-4 p-4 transition-colors hover:bg-muted/50">
      <Link href={`/agent/${agent.urlKey}`} className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
          {agent.name.charAt(0)}
        </div>
        <div className="min-w-0">
          <p className="font-medium">{agent.name}</p>
          <p className="text-sm text-muted-foreground">{agent.title}</p>
        </div>
      </Link>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 text-sm">
        <span className="text-muted-foreground capitalize">{agent.role}</span>
        <Badge
          variant={heartbeat.timerEnabled ? 'default' : 'outline'}
          className="font-normal"
          title={
            heartbeat.timerEnabled
              ? `Automatic heartbeat every ${heartbeat.intervalSec}s`
              : 'Automatic timer heartbeats disabled'
          }
        >
          {heartbeat.label}
        </Badge>
        {canToggle ? (
          <form action={toggleAgentActiveAction}>
            <input type="hidden" name="agentId" value={agent.id} />
            <input type="hidden" name="active" value={isActive ? 'false' : 'true'} />
            <button
              type="submit"
              className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                isActive ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground'
              }`}
            >
              {isActive ? 'Active' : 'Inactive'}
            </button>
          </form>
        ) : (
          <StatusBadge status={agent.status} />
        )}
      </div>
    </div>
  );
}
