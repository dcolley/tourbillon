import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { db, agents, heartbeatRuns } from '@tourbillon/db';
import { eq, desc } from 'drizzle-orm';
import type { AgentRuntimeConfig } from '@tourbillon/shared';
import { TOOLSET_CATALOG, modelProviderOverridesFromAgent, resolveModelProviderConfig } from '@tourbillon/shared';
import { AgentValidationError, getAgentByUrlKey, updateAgentRuntimeConfig, updateAgentAssignedToolsets } from '@/lib/agents';
import { heartbeatJobHref } from '@/lib/heartbeats';
import { triggerAgentHeartbeat } from '@/lib/heartbeat';
import { listRoutinesForAgent, setRoutineEnabled } from '@/lib/routines';

async function runHeartbeat(formData: FormData) {
  'use server';

  const agentId = formData.get('agentId') as string;
  const companyId = formData.get('companyId') as string;
  const urlKey = formData.get('urlKey') as string;

  let queueError: string | null = null;
  let jobId: string | undefined;
  try {
    jobId = await triggerAgentHeartbeat(agentId, companyId);
  } catch (err) {
    queueError = err instanceof Error ? err.message : 'Failed to queue heartbeat.';
  }

  if (queueError) {
    redirect(`/agent/${urlKey}?error=${encodeURIComponent(queueError)}`);
  }

  if (!jobId) {
    redirect(`/agent/${urlKey}?error=${encodeURIComponent('Heartbeat was not queued — a job may already exist for this agent.')}`);
  }

  redirect(`/jobs/heartbeat/${jobId}?state=waiting`);
}

async function updateHeartbeatConfig(formData: FormData) {
  'use server';

  const agentId = formData.get('agentId') as string;
  const urlKey = formData.get('urlKey') as string;
  const enabled = formData.get('heartbeatEnabled') === 'on';
  const intervalSec = parseInt(formData.get('intervalSec') as string, 10);

  if (!Number.isFinite(intervalSec) || intervalSec < 60) {
    redirect(`/agent/${urlKey}?error=${encodeURIComponent('Interval must be at least 60 seconds.')}`);
  }

  try {
    await updateAgentRuntimeConfig(agentId, {
      heartbeat: { enabled, intervalSec },
    });
  } catch (err) {
    const message = err instanceof AgentValidationError ? err.message : 'Failed to update heartbeat settings.';
    redirect(`/agent/${urlKey}?error=${encodeURIComponent(message)}`);
  }

  redirect(`/agent/${urlKey}?saved=heartbeat`);
}

async function updateToolsets(formData: FormData) {
  'use server';

  const agentId = formData.get('agentId') as string;
  const urlKey = formData.get('urlKey') as string;
  const selected = TOOLSET_CATALOG.filter(
    (entry) => formData.get(`toolset_${entry.id}`) === 'on'
  ).map((entry) => entry.id);

  try {
    await updateAgentAssignedToolsets(agentId, selected);
  } catch (err) {
    const message = err instanceof AgentValidationError ? err.message : 'Failed to update toolsets.';
    redirect(`/agent/${urlKey}?error=${encodeURIComponent(message)}`);
  }

  redirect(`/agent/${urlKey}?saved=toolsets`);
}

async function toggleRoutine(formData: FormData) {
  'use server';

  const routineId = formData.get('routineId') as string;
  const agentId = formData.get('agentId') as string;
  const urlKey = formData.get('urlKey') as string;
  const enabled = formData.get('enabled') === 'true';

  await setRoutineEnabled(routineId, agentId, enabled);
  redirect(`/agent/${urlKey}`);
}

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ urlKey: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { urlKey } = await params;
  const { saved, error: errorParam } = await searchParams;
  const agent = await getAgentByUrlKey(urlKey);
  if (!agent) notFound();

  const [manager, directReports, recentRuns, agentRoutines] = await Promise.all([
    agent.reportsToId
      ? db.query.agents.findFirst({ where: eq(agents.id, agent.reportsToId) })
      : Promise.resolve(null),
    db.select().from(agents).where(eq(agents.reportsToId, agent.id)),
    db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agent.id))
      .orderBy(desc(heartbeatRuns.startedAt))
      .limit(5),
    listRoutinesForAgent(agent.id),
  ]);

  const runtime = agent.runtimeConfig as AgentRuntimeConfig;
  const budgetUsedPct = agent.budgetMonthlyTokens
    ? Math.round((agent.spentMonthlyTokens / agent.budgetMonthlyTokens) * 100)
    : 0;

  const canRunHeartbeat =
    agent.status === 'active' && agent.spentMonthlyTokens < agent.budgetMonthlyTokens;
  const error = errorParam ? decodeURIComponent(errorParam) : null;
  const providerConfig = resolveModelProviderConfig(
    modelProviderOverridesFromAgent(agent.adapterType, agent.adapterConfig),
    agent.modelId,
  );

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <Link href="/agent" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to agents
        </Link>
        <div className="flex items-start justify-between mt-2 gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-lg">
              {agent.name.charAt(0)}
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">{agent.name}</h1>
              <p className="text-muted-foreground">{agent.title}</p>
              <p className="text-xs font-mono text-muted-foreground mt-1">/agent/{agent.urlKey}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <AgentStatusBadge status={agent.status} />
            <form action={runHeartbeat}>
              <input type="hidden" name="agentId" value={agent.id} />
              <input type="hidden" name="companyId" value={agent.companyId} />
              <input type="hidden" name="urlKey" value={agent.urlKey} />
              <button
                type="submit"
                disabled={!canRunHeartbeat}
                className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Run heartbeat
              </button>
            </form>
          </div>
        </div>
      </div>

      {saved === 'heartbeat' && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Heartbeat settings saved. Ensure <code className="text-xs">pnpm workers:dev</code> is running for automatic heartbeats.
        </div>
      )}

      {saved === 'toolsets' && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Toolsets saved. Changes apply on the agent&apos;s next heartbeat.
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <section className="grid grid-cols-2 gap-4">
        <DetailCard label="Role" value={agent.role} />
        <DetailCard label="Agent ID" value={agent.urlKey} mono />
        <DetailCard label="Model" value={agent.modelId ?? '—'} mono />
        <DetailCard label="Provider" value={providerConfig.provider} />
        <DetailCard label="API mode" value={providerConfig.apiMode} />
        <DetailCard label="Adapter" value={agent.adapterType} />
      </section>

      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-semibold">Org chart</h2>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Reports to</dt>
            <dd className="font-medium mt-0.5">
              {manager ? (
                <Link href={`/agent/${manager.urlKey}`} className="hover:underline">
                  {manager.name}
                </Link>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Direct reports</dt>
            <dd className="font-medium mt-0.5">
              {directReports.length === 0 ? (
                '—'
              ) : (
                <ul className="space-y-1">
                  {directReports.map((report) => (
                    <li key={report.id}>
                      <Link href={`/agent/${report.urlKey}`} className="hover:underline">
                        {report.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section className="border rounded-lg p-4 space-y-4">
        <h2 className="text-sm font-semibold">Capabilities</h2>
        <div className="space-y-2 text-sm">
          <div>
            <p className="text-muted-foreground mb-1">Skills</p>
            <TagList items={agent.assignedSkills} />
          </div>
          {agent.mcpServerIds.length > 0 && (
            <div>
              <p className="text-muted-foreground mb-1">MCP servers</p>
              <TagList items={agent.mcpServerIds} />
            </div>
          )}
        </div>

        <form action={updateToolsets} className="space-y-3 border-t pt-4">
          <input type="hidden" name="agentId" value={agent.id} />
          <input type="hidden" name="urlKey" value={agent.urlKey} />
          <div>
            <p className="text-sm font-medium">Toolsets</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Always included: control-plane tools (inbox, checkout, create subtask, update issue, etc.)
            </p>
          </div>
          <ul className="space-y-3">
            {TOOLSET_CATALOG.map((entry) => {
              const checked =
                agent.assignedToolsets.includes(entry.id) ||
                (entry.id === 'roster' && agent.assignedToolsets.includes('agent-management'));
              return (
                <li key={entry.id}>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      name={`toolset_${entry.id}`}
                      defaultChecked={checked}
                      className="mt-0.5 rounded border-input"
                    />
                    <span>
                      <span className="font-medium">{entry.label}</span>
                      <span className="block text-xs text-muted-foreground">{entry.description}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Save toolsets
          </button>
        </form>
      </section>

      <section className="border rounded-lg p-4 space-y-4">
        <h2 className="text-sm font-semibold">Automatic heartbeats</h2>
        <form action={updateHeartbeatConfig} className="space-y-4 text-sm">
          <input type="hidden" name="agentId" value={agent.id} />
          <input type="hidden" name="urlKey" value={agent.urlKey} />
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="heartbeatEnabled"
              defaultChecked={runtime.heartbeat?.enabled ?? false}
              className="rounded border-input"
            />
            <span>Enable automatic heartbeats</span>
          </label>
          <div>
            <label htmlFor="intervalSec" className="text-muted-foreground block mb-1">
              Interval (seconds)
            </label>
            <input
              id="intervalSec"
              name="intervalSec"
              type="number"
              min={60}
              step={60}
              defaultValue={runtime.heartbeat?.intervalSec || 300}
              className="w-32 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">Minimum 60s. Requires workers running.</p>
          </div>
          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Save heartbeat settings
          </button>
        </form>
        <dl className="grid grid-cols-2 gap-3 text-sm border-t pt-3">
          <div>
            <dt className="text-muted-foreground">Timeout</dt>
            <dd className="font-medium mt-0.5">{runtime.timeout?.heartbeatSec ?? 300}s</dd>
          </div>
        </dl>
      </section>

      {agentRoutines.length > 0 && (
        <section className="border rounded-lg divide-y">
          <div className="p-4">
            <h2 className="text-sm font-semibold">Routines</h2>
            <p className="text-xs text-muted-foreground mt-1">Cron-based wakes that create issues then trigger heartbeats.</p>
          </div>
          {agentRoutines.map((routine) => (
            <div key={routine.id} className="flex items-center justify-between gap-4 p-4 text-sm">
              <div>
                <p className="font-medium">{routine.name}</p>
                <p className="text-xs font-mono text-muted-foreground mt-0.5">{routine.cronExpression}</p>
                <p className="text-xs text-muted-foreground">{routine.timezone}</p>
              </div>
              <form action={toggleRoutine}>
                <input type="hidden" name="routineId" value={routine.id} />
                <input type="hidden" name="agentId" value={agent.id} />
                <input type="hidden" name="urlKey" value={agent.urlKey} />
                <input type="hidden" name="enabled" value={routine.enabled ? 'false' : 'true'} />
                <button
                  type="submit"
                  className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                    routine.enabled ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {routine.enabled ? 'Enabled' : 'Disabled'}
                </button>
              </form>
            </div>
          ))}
        </section>
      )}

      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-semibold">Budget</h2>
        <div className="text-sm">
          <p className="font-medium">
            {agent.spentMonthlyTokens.toLocaleString()} / {agent.budgetMonthlyTokens.toLocaleString()} tokens
          </p>
          <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary rounded-full"
              style={{ width: `${Math.min(budgetUsedPct, 100)}%` }}
            />
          </div>
          <p className="text-muted-foreground mt-1">{budgetUsedPct}% used this month</p>
        </div>
      </section>

      <section className="border rounded-lg divide-y">
        <div className="flex items-center justify-between p-4">
          <h2 className="text-sm font-semibold">Recent heartbeats</h2>
          {recentRuns.length > 0 && (
            <Link
              href={`/jobs/heartbeat?agent=${agent.urlKey}`}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              View all
            </Link>
          )}
        </div>
        {recentRuns.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No heartbeats yet.</p>
        ) : (
          recentRuns.map((run) => (
            <Link
              key={run.id}
              href={heartbeatJobHref(run) ?? `/heartbeat/${run.id}`}
              className="flex items-center justify-between p-4 text-sm hover:bg-accent/50 transition-colors"
            >
              <div className="space-y-0.5 min-w-0">
                <p className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}…</p>
                <p className="text-muted-foreground capitalize">{run.invocationSource.replace(/_/g, ' ')}</p>
                <time className="text-xs text-muted-foreground" dateTime={run.startedAt.toISOString()}>
                  {run.startedAt.toLocaleString()}
                </time>
              </div>
              <RunStatusBadge status={run.status} />
            </Link>
          ))
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        Created {new Date(agent.createdAt).toLocaleString()}
      </p>
    </div>
  );
}

function DetailCard({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="border rounded-lg p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={`font-medium mt-1 capitalize ${mono ? 'font-mono text-sm normal-case' : ''}`}>
        {value}
      </p>
    </div>
  );
}

function TagList({ items, emptyLabel = 'None' }: { items: string[]; emptyLabel?: string }) {
  if (items.length === 0) {
    return <span className="text-sm text-muted-foreground">{emptyLabel}</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item}
          className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium"
        >
          {item}
        </span>
      ))}
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
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${styles[status] ?? 'bg-muted text-muted-foreground'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    succeeded: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
    running: 'bg-blue-100 text-blue-700',
    queued: 'bg-yellow-100 text-yellow-700',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? 'bg-muted text-muted-foreground'}`}>
      {status}
    </span>
  );
}
