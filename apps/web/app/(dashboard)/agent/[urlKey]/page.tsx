import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { db, agents, heartbeatRuns } from '@tourbillon/db';
import { eq, desc } from 'drizzle-orm';
import type { AgentRuntimeConfig } from '@tourbillon/shared';
import { modelProviderOverridesFromAgent, resolveModelProviderConfig, isAgentBudgetEnforced, isAgentBudgetExceeded, agentRuntimeLabel, resolveAssignedTools } from '@tourbillon/shared';
import { AgentValidationError, getAgentByUrlKey, updateAgentRuntimeConfig, updateAgentCapabilities, updateAgentBudget, updateAgentInstructions, updateAgentModel, updateAgentProfile } from '@/lib/agents';
import { getLlmProviderRecordById, listLlmProvidersPublic } from '@/lib/llm-providers';
import { AgentModelForm } from './agent-model-form';
import { heartbeatJobHref } from '@/lib/heartbeats';
import { triggerAgentHeartbeat } from '@/lib/heartbeat';
import { listRoutinesForAgent, setRoutineEnabled } from '@/lib/routines';
import { listGoalOptions } from '@/lib/goals';
import { listProjectOptions } from '@/lib/projects';
import { AgentDetailTabs } from './agent-detail-tabs';
import { AgentObservabilityTab } from './agent-observability-tab';
import { AgentCapabilitiesForm } from './agent-capabilities-form';

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

async function updateCapabilities(formData: FormData) {
  'use server';

  const agentId = formData.get('agentId') as string;
  const urlKey = formData.get('urlKey') as string;

  const { GRANULAR_TOOL_GROUPS } = await import('@tourbillon/shared/tool-catalog');
  const { TOOLSET_CATALOG } = await import('@tourbillon/shared/constants');

  const allToolIds = GRANULAR_TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.id));
  const assignedTools = allToolIds.filter((id) => formData.get(`tool_${id}`) === 'on');

  const toolsets = TOOLSET_CATALOG.filter(
    (entry) => formData.get(`toolset_${entry.id}`) === 'on',
  ).map((entry) => entry.id);

  try {
    await updateAgentCapabilities(agentId, { toolsets, assignedTools });
  } catch (err) {
    const message = err instanceof AgentValidationError ? err.message : 'Failed to update capabilities.';
    redirect(`/agent/${urlKey}?error=${encodeURIComponent(message)}`);
  }

  redirect(`/agent/${urlKey}?saved=toolsets`);
}

async function updateBudgetConfig(formData: FormData) {
  'use server';

  const agentId = formData.get('agentId') as string;
  const urlKey = formData.get('urlKey') as string;
  const enforce = formData.get('enforceBudget') === 'on';
  const budgetMonthlyTokens = parseInt(formData.get('budgetMonthlyTokens') as string, 10);

  if (!Number.isInteger(budgetMonthlyTokens) || budgetMonthlyTokens < 0) {
    redirect(`/agent/${urlKey}?error=${encodeURIComponent('Monthly token budget must be a non-negative integer.')}`);
  }

  try {
    await updateAgentBudget(agentId, { budgetMonthlyTokens, enforce });
  } catch (err) {
    const message = err instanceof AgentValidationError ? err.message : 'Failed to update budget settings.';
    redirect(`/agent/${urlKey}?error=${encodeURIComponent(message)}`);
  }

  redirect(`/agent/${urlKey}?saved=budget`);
}

async function updateProfile(formData: FormData) {
  'use server';

  const agentId = formData.get('agentId') as string;
  const currentUrlKey = formData.get('currentUrlKey') as string;
  const reportsToRaw = formData.get('reportsToId') as string;

  let updated;
  try {
    updated = await updateAgentProfile(agentId, {
      name: formData.get('name') as string,
      urlKey: formData.get('urlKey') as string,
      reportsToId: reportsToRaw || null,
    });
  } catch (err) {
    const message = err instanceof AgentValidationError ? err.message : 'Failed to update agent profile.';
    redirect(`/agent/${currentUrlKey}?error=${encodeURIComponent(message)}`);
  }

  redirect(`/agent/${updated.urlKey}?saved=profile`);
}

async function updateModel(formData: FormData) {
  'use server';

  const agentId = formData.get('agentId') as string;
  const urlKey = formData.get('urlKey') as string;
  const modelId = formData.get('modelId') as string;
  const providerId = formData.get('providerId') as string | null;

  try {
    await updateAgentModel(agentId, { modelId, providerId });
  } catch (err) {
    const message = err instanceof AgentValidationError ? err.message : 'Failed to update model.';
    redirect(`/agent/${urlKey}?error=${encodeURIComponent(message)}`);
  }

  redirect(`/agent/${urlKey}?saved=model`);
}

async function updateInstructions(formData: FormData) {
  'use server';

  const agentId = formData.get('agentId') as string;
  const urlKey = formData.get('urlKey') as string;

  try {
    await updateAgentInstructions(agentId, {
      soulMd: formData.get('instructionsBundleSoulMd') as string,
      agentsMd: formData.get('instructionsBundleAgentsMd') as string,
    });
  } catch (err) {
    const message = err instanceof AgentValidationError ? err.message : 'Failed to update instructions.';
    redirect(`/agent/${urlKey}?error=${encodeURIComponent(message)}`);
  }

  redirect(`/agent/${urlKey}?saved=instructions`);
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

  const [directReports, companyAgents, recentRuns, agentRoutines, goals, projects, providerList, providerRecord] =
    await Promise.all([
    db.select().from(agents).where(eq(agents.reportsToId, agent.id)),
    db
      .select({ id: agents.id, name: agents.name, urlKey: agents.urlKey, title: agents.title })
      .from(agents)
      .where(eq(agents.companyId, agent.companyId))
      .orderBy(agents.name),
    db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agent.id))
      .orderBy(desc(heartbeatRuns.startedAt))
      .limit(5),
    listRoutinesForAgent(agent.id),
    listGoalOptions(),
    listProjectOptions(),
    listLlmProvidersPublic(),
    agent.providerId ? getLlmProviderRecordById(agent.providerId) : Promise.resolve(null),
  ]);

  const runtime = agent.runtimeConfig as AgentRuntimeConfig;
  const budgetEnforced = isAgentBudgetEnforced(runtime);
  const budgetUsedPct = agent.budgetMonthlyTokens
    ? Math.round((agent.spentMonthlyTokens / agent.budgetMonthlyTokens) * 100)
    : 0;

  const canRunHeartbeat =
    agent.status === 'active' &&
    !isAgentBudgetExceeded(agent.spentMonthlyTokens, agent.budgetMonthlyTokens, runtime);
  const error = errorParam ? decodeURIComponent(errorParam) : null;
  const providerConfig = resolveModelProviderConfig(
    modelProviderOverridesFromAgent(agent.adapterType, agent.adapterConfig),
    agent.modelId,
    providerRecord,
  );

  const enabledTools = resolveAssignedTools({
    role: agent.role,
    assignedToolsets: agent.assignedToolsets,
    runtimeConfig: runtime,
  });

  return (
    <div className="p-6 space-y-6 max-w-5xl">
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
          Capabilities saved. Changes apply on the agent&apos;s next heartbeat.
        </div>
      )}

      {saved === 'budget' && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
          Budget settings saved.
        </div>
      )}

      {saved === 'instructions' && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Instructions saved. Changes apply on the agent&apos;s next heartbeat.
        </div>
      )}

      {saved === 'profile' && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Agent profile saved.
        </div>
      )}

      {saved === 'model' && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          Model saved. Changes apply on the agent&apos;s next heartbeat.
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <AgentDetailTabs
        overview={
          <>
      <section className="border rounded-lg p-4 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Profile</h2>
          <p className="text-xs text-muted-foreground mt-1">Name, URL slug, and reporting line.</p>
        </div>
        <form action={updateProfile} className="space-y-4">
          <input type="hidden" name="agentId" value={agent.id} />
          <input type="hidden" name="currentUrlKey" value={agent.urlKey} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="agent-name" className="text-sm font-medium">
                Name
              </label>
              <input
                id="agent-name"
                name="name"
                type="text"
                required
                defaultValue={agent.name}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="agent-url-key" className="text-sm font-medium">
                Agent ID
              </label>
              <input
                id="agent-url-key"
                name="urlKey"
                type="text"
                required
                defaultValue={agent.urlKey}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
              />
              <p className="text-xs text-muted-foreground">
                URL slug — <span className="font-mono">/agent/{agent.urlKey}</span>. Changing this
                only updates the link; issues, heartbeats, and other records stay tied to the same
                internal agent.
              </p>
            </div>
          </div>
          <div className="space-y-1.5 max-w-md">
            <label htmlFor="agent-reports-to" className="text-sm font-medium">
              Reports to
            </label>
            <select
              id="agent-reports-to"
              name="reportsToId"
              defaultValue={agent.reportsToId ?? ''}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">None</option>
              {companyAgents
                .filter((a) => a.id !== agent.id)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.title})
                  </option>
                ))}
            </select>
          </div>
          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Save profile
          </button>
        </form>
        {directReports.length > 0 && (
          <div className="border-t pt-4 text-sm">
            <p className="text-muted-foreground mb-2">Direct reports</p>
            <ul className="space-y-1">
              {directReports.map((report) => (
                <li key={report.id}>
                  <Link href={`/agent/${report.urlKey}`} className="font-medium hover:underline">
                    {report.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="border rounded-lg p-4 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Model</h2>
          <p className="text-xs text-muted-foreground mt-1">
            LLM used on heartbeats. Select a registered provider and model identifier.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <DetailCard label="Agent type" value={agentRuntimeLabel(agent.adapterType)} />
          <DetailCard
            label="Provider"
            value={providerConfig.providerName ?? providerConfig.provider}
          />
          <DetailCard label="API mode" value={providerConfig.apiMode} />
          <DetailCard label="Endpoint" value={providerConfig.baseURL} />
        </div>
        <AgentModelForm
          agentId={agent.id}
          urlKey={agent.urlKey}
          initialModelId={agent.modelId ?? providerConfig.defaultModel}
          initialProviderId={agent.providerId}
          providers={providerList.map((p) => ({
            id: p.id,
            name: p.name,
            type: p.type,
            baseURL: p.baseURL,
            isDefault: p.isDefault,
          }))}
          updateModel={updateModel}
        />
      </section>

      <section className="grid grid-cols-2 gap-4">
        <DetailCard label="Role" value={agent.role} />
        <DetailCard label="Title" value={agent.title} />
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

        <AgentCapabilitiesForm
          agentId={agent.id}
          urlKey={agent.urlKey}
          assignedToolsets={agent.assignedToolsets}
          enabledTools={enabledTools}
          updateCapabilities={updateCapabilities}
        />
      </section>

      <section className="border rounded-lg p-4 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Instructions</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Injected into the system prompt on every heartbeat — SOUL first, then AGENTS, then assigned skills.
          </p>
        </div>
        <form action={updateInstructions} className="space-y-4">
          <input type="hidden" name="agentId" value={agent.id} />
          <input type="hidden" name="urlKey" value={agent.urlKey} />
          <div className="space-y-1.5">
            <label htmlFor="instructionsBundleSoulMd" className="text-sm font-medium">
              SOUL.md
            </label>
            <p className="text-xs text-muted-foreground">Personality, values, and communication style.</p>
            <textarea
              id="instructionsBundleSoulMd"
              name="instructionsBundleSoulMd"
              rows={12}
              defaultValue={agent.instructionsBundleSoulMd ?? ''}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="instructionsBundleAgentsMd" className="text-sm font-medium">
              AGENTS.md
            </label>
            <p className="text-xs text-muted-foreground">Role responsibilities, domain context, and constraints.</p>
            <textarea
              id="instructionsBundleAgentsMd"
              name="instructionsBundleAgentsMd"
              rows={12}
              defaultValue={agent.instructionsBundleAgentsMd ?? ''}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
          </div>
          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Save instructions
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

      <section className="border rounded-lg p-4 space-y-4">
        <h2 className="text-sm font-semibold">Budget</h2>
        <div className="text-sm">
          <p className="font-medium">
            {agent.spentMonthlyTokens.toLocaleString()} / {agent.budgetMonthlyTokens.toLocaleString()} tokens
          </p>
          <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full ${budgetEnforced && budgetUsedPct >= 100 ? 'bg-destructive' : 'bg-primary'}`}
              style={{ width: `${Math.min(budgetUsedPct, 100)}%` }}
            />
          </div>
          <p className="text-muted-foreground mt-1">
            {budgetUsedPct}% used this month
            {!budgetEnforced && ' · enforcement off'}
          </p>
        </div>

        <form action={updateBudgetConfig} className="space-y-4 border-t pt-4 text-sm">
          <input type="hidden" name="agentId" value={agent.id} />
          <input type="hidden" name="urlKey" value={agent.urlKey} />

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="enforceBudget"
              defaultChecked={budgetEnforced}
              className="rounded border-input"
            />
            <span>Enforce monthly token budget</span>
          </label>
          <p className="text-xs text-muted-foreground -mt-2 pl-6">
            When off, heartbeats run even if the agent is over its allocation. Usage is still tracked.
          </p>

          <div>
            <label htmlFor="budgetMonthlyTokens" className="text-muted-foreground block mb-1">
              Monthly token allocation
            </label>
            <input
              id="budgetMonthlyTokens"
              name="budgetMonthlyTokens"
              type="number"
              min={0}
              step={1}
              required
              defaultValue={agent.budgetMonthlyTokens}
              className="w-full max-w-xs rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            />
          </div>

          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Save budget settings
          </button>
        </form>
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
          </>
        }
        observability={
          <AgentObservabilityTab
            agentId={agent.id}
            agentName={agent.name}
            goals={goals}
            projects={projects}
          />
        }
      />
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
