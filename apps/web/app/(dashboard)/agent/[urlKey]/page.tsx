import Link from 'next/link';
import { notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { db, agents, heartbeatRuns } from '@tourbillon/db';
import { eq, desc } from 'drizzle-orm';
import type { AgentRuntimeConfig } from '@tourbillon/shared';
import { modelProviderOverridesFromAgent, resolveModelProviderConfig, isAgentBudgetEnforced, isAgentBudgetExceeded, agentRuntimeLabel, agentRuntimeFromAdapter, resolveAssignedTools, modelSettingsFromFormData, isCodeExecutionAvailable, formatExecutionWorkspacePathPreview } from '@tourbillon/shared';
import { AgentValidationError, AGENT_ROLE_OPTIONS, getAgentByUrlKey, listAgentsByUrlKey, updateAgentRuntimeConfig, updateAgentCapabilities, updateAgentBudget, updateAgentInstructions, updateAgentModel, updateAgentModelSettings, updateAgentProfile, updateAgentCodeExecution, cloneAgent, suggestCloneUrlKey } from '@/lib/agents';
import { actionError, actionSuccess, type ActionResult } from '@/lib/action-result';
import { AgentDisambiguation } from '@/components/agent-disambiguation';
import { DeepLinkCompanySync } from '@/components/deep-link-company-sync';
import { ActionForm, ActionSubmitButton } from '@/components/action-form';
import { getCompanyById } from '@/lib/company';
import { parseCompanyIdFromSearchParams } from '@/lib/company-link';
import { deleteAgentAction, updateAgentRoleAction } from '../actions';
import { getLlmProviderRecordById, listLlmProvidersPublic } from '@/lib/llm-providers';
import { AgentModelForm } from './agent-model-form';
import { AgentModelSettingsForm } from './agent-model-settings-form';
import { getInFlightHeartbeatRun, heartbeatJobHref } from '@/lib/heartbeats';
import { listRoutinesForAgent, setRoutineEnabled } from '@/lib/routines';
import { listGoalOptions } from '@/lib/goals';
import { listProjectOptions } from '@/lib/projects';
import { AgentDetailTabs } from './agent-detail-tabs';
import { AgentObservabilityTab } from './agent-observability-tab';
import { AgentMemoryTab } from './agent-memory-tab';
import { AgentCapabilitiesForm } from './agent-capabilities-form';
import { AgentCodeExecutionForm } from './agent-code-execution-form';
import { AgentHeartbeatForm } from './agent-heartbeat-form';
import { AgentHeartbeatHeaderActions } from './agent-heartbeat-header-actions';
import { AgentQueryToast } from './agent-query-toast';
import { AgentRoutineToggle } from './agent-routine-toggle';
import { AgentCloneForm } from './agent-clone-form';

async function updateHeartbeatConfig(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  'use server';

  const agentId = formData.get('agentId') as string;
  const enabled = formData.get('heartbeatEnabled') === 'on';
  const scheduleMode = (formData.get('scheduleMode') as 'interval' | 'cron') || 'interval';

  const heartbeat: Partial<AgentRuntimeConfig['heartbeat']> = {
    enabled,
    scheduleMode,
  };

  if (scheduleMode === 'interval') {
    const intervalSec = parseInt(formData.get('intervalSec') as string, 10);
    heartbeat.intervalSec = Number.isFinite(intervalSec) ? intervalSec : 300;
  } else {
    heartbeat.cronExpression = ((formData.get('cronExpression') as string) ?? '').trim();
    heartbeat.timezone = ((formData.get('timezone') as string) || 'UTC').trim() || 'UTC';
    heartbeat.intervalSec = 0;
  }

  try {
    await updateAgentRuntimeConfig(agentId, { heartbeat });
  } catch (err) {
    return actionError(
      err instanceof AgentValidationError ? err.message : 'Failed to update heartbeat settings.',
    );
  }

  return actionSuccess(
    'Heartbeat settings saved. Ensure pnpm workers:dev is running for automatic heartbeats.',
  );
}

async function updateCapabilities(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  'use server';

  const agentId = formData.get('agentId') as string;
  const urlKey = formData.get('urlKey') as string;

  const { GRANULAR_TOOL_GROUPS } = await import('@tourbillon/shared/tool-catalog');
  const { TOOLSET_CATALOG } = await import('@tourbillon/shared/constants');

  const allToolIds = GRANULAR_TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.id));
  const assignedTools = allToolIds.filter((id) => formData.get(`tool_${id}`) === 'on');

  const toolsets = TOOLSET_CATALOG.filter(
    (entry) => entry.id !== 'code-execution' && formData.get(`toolset_${entry.id}`) === 'on',
  ).map((entry) => entry.id);

  const existingAgent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (existingAgent?.assignedToolsets.includes('code-execution')) {
    toolsets.push('code-execution');
  }

  const integrationKeys = formData.getAll('integrationKey').map(String);
  const integrationValues = formData.getAll('integrationValue').map(String);
  const integrations: Record<string, string> = {};
  for (let i = 0; i < integrationKeys.length; i++) {
    const key = integrationKeys[i]?.trim();
    const value = integrationValues[i]?.trim();
    if (!key || !value) continue;
    integrations[key] = value;
  }
  const clearIntegrations = formData.getAll('clearIntegration').map(String);

  const mcpToolPolicy: Record<string, { allow: string[] }> = {};
  for (const serverId of formData.getAll('mcpServerPolicy').map(String)) {
    if (!serverId.trim()) continue;
    mcpToolPolicy[serverId] = {
      allow: formData.getAll(`mcpAllow_${serverId}`).map(String).filter(Boolean),
    };
  }

  const knowledgeGraph = {
    private: formData.get('kgMountPrivate') === 'on',
    company: formData.get('kgMountCompany') === 'on',
  };

  try {
    await updateAgentCapabilities(agentId, {
      toolsets,
      assignedTools,
      integrations,
      clearIntegrations,
      mcpToolPolicy,
      knowledgeGraph,
    });
  } catch (err) {
    return actionError(
      err instanceof AgentValidationError ? err.message : 'Failed to update capabilities.',
    );
  }

  if (urlKey) {
    revalidatePath(`/agent/${urlKey}`);
  }

  return actionSuccess("Capabilities saved. Changes apply on the agent's next heartbeat.");
}

async function updateCodeExecution(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  'use server';

  const agentId = formData.get('agentId') as string;
  const runtimeType = (formData.get('runtimeType') as 'agent' | 'harness') || 'agent';
  const codeExecutionEnabled = formData.get('codeExecutionEnabled') === 'on';

  const timeoutRaw = (formData.get('codeExecutionTimeoutMs') as string)?.trim();
  const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;
  if (timeoutRaw && (!Number.isFinite(timeoutMs) || timeoutMs! < 1000)) {
    return actionError('Timeout must be at least 1000 ms.');
  }

  const isolation = (formData.get('codeExecutionIsolation') as string) || null;

  try {
    await updateAgentCodeExecution(agentId, {
      runtimeType,
      codeExecutionEnabled,
      timeoutMs: timeoutRaw ? timeoutMs : undefined,
      isolation,
      clearCodeExecutionOverrides: formData.get('clearCodeExecutionOverrides') === 'on',
    });
  } catch (err) {
    return actionError(
      err instanceof AgentValidationError
        ? err.message
        : 'Failed to update code execution settings.',
    );
  }

  return actionSuccess(
    "Code & execution settings saved. Changes apply on the agent's next heartbeat.",
  );
}

async function updateBudgetConfig(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  'use server';

  const agentId = formData.get('agentId') as string;
  const enforce = formData.get('enforceBudget') === 'on';
  const budgetMonthlyTokens = parseInt(formData.get('budgetMonthlyTokens') as string, 10);

  if (!Number.isInteger(budgetMonthlyTokens) || budgetMonthlyTokens < 0) {
    return actionError('Monthly token budget must be a non-negative integer.');
  }

  try {
    await updateAgentBudget(agentId, { budgetMonthlyTokens, enforce });
  } catch (err) {
    return actionError(
      err instanceof AgentValidationError ? err.message : 'Failed to update budget settings.',
    );
  }

  return actionSuccess('Budget settings saved.');
}

async function updateProfile(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
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
    return actionError(
      err instanceof AgentValidationError ? err.message : 'Failed to update agent profile.',
    );
  }

  if (updated.urlKey !== currentUrlKey) {
    return actionSuccess('Agent profile saved.', `/agent/${updated.urlKey}`);
  }
  return actionSuccess('Agent profile saved.');
}

async function updateModel(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  'use server';

  const agentId = formData.get('agentId') as string;
  const modelId = formData.get('modelId') as string;
  const providerId = formData.get('providerId') as string | null;

  try {
    await updateAgentModel(agentId, { modelId, providerId });
  } catch (err) {
    return actionError(
      err instanceof AgentValidationError ? err.message : 'Failed to update model.',
    );
  }

  return actionSuccess("Model saved. Changes apply on the agent's next heartbeat.");
}

async function updateModelSettings(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  'use server';

  const agentId = formData.get('agentId') as string;

  try {
    const patch = modelSettingsFromFormData(formData);
    await updateAgentModelSettings(agentId, patch);
  } catch (err) {
    return actionError(
      err instanceof AgentValidationError
        ? err.message
        : 'Failed to update generation settings.',
    );
  }

  return actionSuccess("Generation settings saved. Changes apply on the agent's next heartbeat.");
}

async function updateInstructions(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  'use server';

  const agentId = formData.get('agentId') as string;

  try {
    await updateAgentInstructions(agentId, {
      soulMd: formData.get('instructionsBundleSoulMd') as string,
      agentsMd: formData.get('instructionsBundleAgentsMd') as string,
    });
  } catch (err) {
    return actionError(
      err instanceof AgentValidationError ? err.message : 'Failed to update instructions.',
    );
  }

  return actionSuccess("Instructions saved. Changes apply on the agent's next heartbeat.");
}

async function toggleRoutine(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  'use server';

  const routineId = formData.get('routineId') as string;
  const agentId = formData.get('agentId') as string;
  const enabled = formData.get('enabled') === 'true';

  try {
    await setRoutineEnabled(routineId, agentId, enabled);
  } catch (err) {
    return actionError(err instanceof Error ? err.message : 'Failed to update routine.');
  }

  return actionSuccess(enabled ? 'Routine enabled.' : 'Routine disabled.');
}

async function cloneAgentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  'use server';

  const sourceAgentId = formData.get('sourceAgentId') as string;
  const name = formData.get('name') as string;
  const urlKey = formData.get('urlKey') as string;
  const copyCredentials = formData.get('copyCredentials') === 'on';

  try {
    const created = await cloneAgent({
      sourceAgentId,
      name,
      urlKey,
      copyCredentials,
    });
    return actionSuccess(`Cloned as ${created.name}.`, `/agent/${created.urlKey}`);
  } catch (err) {
    return actionError(
      err instanceof AgentValidationError ? err.message : 'Failed to clone agent.',
    );
  }
}

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ urlKey: string }>;
  searchParams: Promise<{ saved?: string; error?: string; c?: string }>;
}) {
  const { urlKey } = await params;
  const resolvedSearchParams = await searchParams;
  const { saved, error: errorParam } = resolvedSearchParams;
  const companyIdParam = parseCompanyIdFromSearchParams(resolvedSearchParams);

  let agent = companyIdParam
    ? await getAgentByUrlKey(urlKey, companyIdParam)
    : await getAgentByUrlKey(urlKey);

  if (!agent) {
    const matches = await listAgentsByUrlKey(urlKey);
    if (matches.length === 0) notFound();
    if (matches.length > 1 && !companyIdParam) {
      return <AgentDisambiguation urlKey={urlKey} matches={matches} />;
    }
    agent = matches[0]!.agent;
  }

  const company = await getCompanyById(agent.companyId);

  const [
    directReports,
    companyAgents,
    recentRuns,
    inFlightHeartbeat,
    agentRoutines,
    goals,
    projects,
    providerList,
    providerRecord,
    suggestedCloneUrlKey,
  ] = await Promise.all([
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
    getInFlightHeartbeatRun(agent.id),
    listRoutinesForAgent(agent.id),
    listGoalOptions(false, agent.companyId),
    listProjectOptions(undefined, agent.companyId),
    listLlmProvidersPublic(),
    agent.providerId ? getLlmProviderRecordById(agent.providerId) : Promise.resolve(null),
    suggestCloneUrlKey(agent.companyId, agent.urlKey),
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

  const codeExecutionAvailability = await isCodeExecutionAvailable(runtime);
  const sandboxPathPreview = formatExecutionWorkspacePathPreview(agent.companyId);
  const codeExecutionEnabled = agent.assignedToolsets.includes('code-execution');
  const agentRuntimeType = agentRuntimeFromAdapter(agent.adapterType);

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {company ? (
        <DeepLinkCompanySync requiredCompanyId={company.id} requiredCompanyName={company.name} />
      ) : null}
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
            <AgentHeartbeatHeaderActions
              agentId={agent.id}
              companyId={agent.companyId}
              urlKey={agent.urlKey}
              canRunHeartbeat={canRunHeartbeat}
              initialInFlight={inFlightHeartbeat}
            />
          </div>
        </div>
      </div>

      <AgentQueryToast saved={saved} error={error} urlKey={agent.urlKey} />

      <AgentDetailTabs
        overview={
          <>
      <section className="border rounded-lg p-4 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Profile</h2>
          <p className="text-xs text-muted-foreground mt-1">Name, URL slug, and reporting line.</p>
        </div>
        <ActionForm action={updateProfile} className="space-y-4">
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
          <ActionSubmitButton label="Save profile" />
        </ActionForm>
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
        <AgentModelSettingsForm
          agentId={agent.id}
          urlKey={agent.urlKey}
          initialSettings={runtime.model}
          providerDefaults={providerRecord?.defaultModelSettings}
          updateModelSettings={updateModelSettings}
        />
      </section>

      <section className="border rounded-lg p-4 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Role</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Changing role resets skills, toolsets, and assigned tools to that role&apos;s defaults.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <form action={updateAgentRoleAction} className="space-y-4">
            <input type="hidden" name="agentId" value={agent.id} />
            <input type="hidden" name="urlKey" value={agent.urlKey} />
            <div className="space-y-1.5">
              <label htmlFor="agent-role" className="text-sm font-medium">
                Role
              </label>
              <select
                id="agent-role"
                name="role"
                required
                defaultValue={agent.role}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {AGENT_ROLE_OPTIONS.map((role) => (
                  <option key={role.value} value={role.value}>
                    {role.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              Save role
            </button>
          </form>
          <DetailCard label="Title" value={agent.title} />
        </div>
      </section>

      <section className="border rounded-lg p-4 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Code &amp; execution</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Runtime type and isolated sandbox for writing and running code. Orthogonal to other toolsets
            below.
          </p>
        </div>
        <AgentCodeExecutionForm
          agentId={agent.id}
          urlKey={agent.urlKey}
          runtimeType={agentRuntimeType}
          codeExecutionEnabled={codeExecutionEnabled}
          availability={codeExecutionAvailability}
          sandboxPathPreview={sandboxPathPreview}
          timeoutOverride={runtime.codeExecution?.timeoutMs}
          isolationOverride={runtime.codeExecution?.isolation}
          updateCodeExecution={updateCodeExecution}
        />
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
          mcpToolPolicy={runtime.mcpToolPolicy}
          knowledgeGraph={runtime.knowledgeGraph}
          integrationOverrides={{
            ...(runtime.tavilyApiKey ? { tavilyApiKey: runtime.tavilyApiKey } : {}),
            ...(runtime.mcpCredentials?.['buffer-mcp']
              ? { bufferApiKey: runtime.mcpCredentials['buffer-mcp'] }
              : {}),
            ...(runtime.searxngUrl ? { searxngUrl: runtime.searxngUrl } : {}),
            ...(runtime.searxngApiKey ? { searxngApiKey: runtime.searxngApiKey } : {}),
          }}
          updateCapabilities={updateCapabilities}
        />
      </section>

      <section className="border rounded-lg p-4 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Instructions</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Injected into the system prompt on every heartbeat — SOUL first, then AGENTS, then assigned skills.
          </p>
          {agent.assignedToolsets.includes('knowledge-graph') && (
            <p className="text-xs text-muted-foreground mt-2 rounded-md border border-dashed p-2">
              Knowledge graph tip for SOUL/AGENTS: name which mounts this agent has (private / company), prefer
              company for shared durable facts, private for hypotheses and sensitive notes, and always search the
              target scope before writing. Full protocol is in the knowledge-graph skill.
            </p>
          )}
        </div>
        <ActionForm action={updateInstructions} className="space-y-4">
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
          <ActionSubmitButton label="Save instructions" />
        </ActionForm>
      </section>

      <section className="border rounded-lg p-4 space-y-4">
        <h2 className="text-sm font-semibold">Automatic heartbeats</h2>
        <AgentHeartbeatForm
          agentId={agent.id}
          urlKey={agent.urlKey}
          heartbeat={runtime.heartbeat}
          updateHeartbeatConfig={updateHeartbeatConfig}
        />
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
              <AgentRoutineToggle
                routineId={routine.id}
                agentId={agent.id}
                urlKey={agent.urlKey}
                initiallyEnabled={routine.enabled}
                toggleRoutine={toggleRoutine}
              />
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

        <ActionForm action={updateBudgetConfig} className="space-y-4 border-t pt-4 text-sm">
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

          <ActionSubmitButton label="Save budget settings" />
        </ActionForm>
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

      <AgentCloneForm
        sourceAgentId={agent.id}
        defaultName={`${agent.name} (copy)`}
        defaultUrlKey={suggestedCloneUrlKey}
        cloneAgentAction={cloneAgentAction}
      />

      <section className="border border-destructive/30 rounded-lg p-4 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-destructive">Danger zone</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Permanently deletes this agent and cascades heartbeat, cost, and routine history.
            Assigned issues, goals, and projects become unassigned.
          </p>
        </div>
        {directReports.length > 0 ? (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            Cannot delete while this agent has direct reports:{' '}
            {directReports.map((report, i) => (
              <span key={report.id}>
                {i > 0 ? ', ' : ''}
                <Link href={`/agent/${report.urlKey}`} className="font-medium underline">
                  {report.name}
                </Link>
              </span>
            ))}
            . Reassign them first.
          </div>
        ) : (
          <form action={deleteAgentAction} className="space-y-4 max-w-md">
            <input type="hidden" name="agentId" value={agent.id} />
            <input type="hidden" name="urlKey" value={agent.urlKey} />
            <div className="space-y-1.5">
              <label htmlFor="confirm-url-key" className="text-sm font-medium">
                Type <span className="font-mono">{agent.urlKey}</span> to confirm
              </label>
              <input
                id="confirm-url-key"
                name="confirmUrlKey"
                type="text"
                required
                autoComplete="off"
                placeholder={agent.urlKey}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
              />
            </div>
            <button
              type="submit"
              className="inline-flex items-center justify-center rounded-md border border-destructive px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10"
            >
              Delete agent
            </button>
          </form>
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        Created {new Date(agent.createdAt).toLocaleString()}
      </p>
          </>
        }
        memory={
          <section className="border rounded-lg p-4">
            <AgentMemoryTab
              agentId={agent.id}
              urlKey={agent.urlKey}
              hasKnowledgeGraphToolset={agent.assignedToolsets.includes('knowledge-graph')}
            />
          </section>
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
