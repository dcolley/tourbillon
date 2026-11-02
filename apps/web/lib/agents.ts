import {
  db,
  agents,
  companies,
  activityLog,
  assertLlmProviderEnabledForCompany,
  updateAgentRuntimeConfigKeys,
  type Agent,
} from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';
import {
  ROLE_DEFAULT_TOOLSETS,
  ROLE_DEFAULT_ASSIGNED_TOOLS,
  DEFAULT_RUNTIME_CONFIG,
  VALID_TOOLSET_IDS,
  VALID_ASSIGNABLE_TOOL_IDS,
  VALID_AGENT_INTEGRATION_CREDENTIAL_IDS,
  VALID_BUNDLED_SKILL_IDS,
  ensureControlPlaneInSkills,
  resolveModelProviderConfig,
  resolveAdapterFieldsForRuntime,
  parseAgentRuntimeType,
  isHarnessAdapter,
  defaultAgentAdapterType,
  applyModelSettingsPatch,
  parseAgentModelSettings,
  normalizeHeartbeatConfig,
  validateHeartbeatSchedule,
  type AgentModelSettings,
  type AgentModelSettingsPatch,
  type AgentRuntimeConfig,
  type AgentRuntimeType,
  nextBrowserRuntimeConfig,
} from '@tourbillon/shared';
import {
  resolveAgentMcpServerIds,
  listToggleableMcpServerDefinitions,
  getMcpServerDefinition,
} from '@tourbillon/shared/mcp-registry';
import {
  seedAgentSkillsFromTemplates,
  buildAssignedSkills,
  copyAgentWorkspaceSkills,
  discoverCompanySkillSlugs,
} from '@tourbillon/shared/company-workspace';
import { getActiveCompany } from './company';
import { getCompanyDefaultLlmProviderRecord } from './llm-providers';
import type { AgentAvatarConfig } from '@tourbillon/shared/agent-avatar';
import { invalidateChatControllerForAgent } from './chat';
import { clearIdleThreadOnRuntimeSwitch } from '@tourbillon/mastra';
import {
  applyCodeExecutionOverrides,
  buildCodeExecutionActivityDetails,
} from './code-execution-config';

const AGENT_ROLES = ['ceo', 'cto', 'engineer', 'pm', 'qa', 'designer', 'custom'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_ROLE_OPTIONS = [
  { value: 'ceo', label: 'CEO' },
  { value: 'cto', label: 'CTO' },
  { value: 'engineer', label: 'Engineer' },
  { value: 'pm', label: 'Product Manager' },
  { value: 'qa', label: 'QA' },
  { value: 'designer', label: 'Designer' },
  { value: 'custom', label: 'Custom' },
] as const satisfies ReadonlyArray<{ value: AgentRole; label: string }>;

/** Reserved path segments — cannot be used as agent IDs in /agent/:id URLs */
const RESERVED_AGENT_IDS = new Set(['new']);

export async function getAgentByUrlKey(urlKey: string, companyId?: string): Promise<Agent | null> {
  const normalized = urlKey?.trim();
  if (!normalized || RESERVED_AGENT_IDS.has(normalized)) return null;

  if (companyId) {
    return (
      (await db.query.agents.findFirst({
        where: and(eq(agents.companyId, companyId), eq(agents.urlKey, normalized)),
      })) ?? null
    );
  }

  try {
    const company = await getActiveCompany();
    return (
      (await db.query.agents.findFirst({
        where: and(eq(agents.companyId, company.id), eq(agents.urlKey, normalized)),
      })) ?? null
    );
  } catch {
    return null;
  }
}

export interface AgentUrlKeyMatch {
  agent: Agent;
  companyName: string;
}

export async function listAgentsByUrlKey(urlKey: string): Promise<AgentUrlKeyMatch[]> {
  const normalized = urlKey?.trim();
  if (!normalized || RESERVED_AGENT_IDS.has(normalized)) return [];

  const rows = await db
    .select({ agent: agents, companyName: companies.name })
    .from(agents)
    .innerJoin(companies, eq(agents.companyId, companies.id))
    .where(eq(agents.urlKey, normalized));

  return rows.map((row) => ({ agent: row.agent, companyName: row.companyName }));
}

export class AgentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentValidationError';
  }
}

export function slugifyUrlKey(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isValidUrlKey(urlKey: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(urlKey);
}

export interface CreateAgentInput {
  name: string;
  title: string;
  role: string;
  urlKey?: string;
  companyId?: string;
  reportsToId?: string | null;
  instructionsBundleSoulMd?: string;
  instructionsBundleAgentsMd?: string;
  runtimeType?: AgentRuntimeType;
  codeExecutionEnabled?: boolean;
}

function normalizeInstructionField(value: string | undefined | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * PRV-1: refuse saving an agent onto a provider that is switched off for its company.
 * Agents already on such a provider keep the run-time fallback to the company default.
 */
async function assertAgentProviderOnForCompany(
  companyId: string,
  providerId: string | null | undefined,
): Promise<void> {
  try {
    await assertLlmProviderEnabledForCompany(companyId, providerId);
  } catch (err) {
    if (err instanceof Error && err.name === 'LlmProviderDisabledForCompanyError') {
      throw new AgentValidationError(err.message);
    }
    throw err;
  }
}

/** Provider a new agent starts on: the default when it is on for the company, else the company's fallback. */
async function newAgentProviderForCompany(companyId: string) {
  try {
    return await getCompanyDefaultLlmProviderRecord(companyId);
  } catch (err) {
    if (err instanceof Error && err.name === 'NoEnabledLlmProviderError') {
      throw new AgentValidationError(err.message);
    }
    throw err;
  }
}

export async function createAgent(input: CreateAgentInput): Promise<Agent> {
  const name = input.name?.trim();
  const title = input.title?.trim();
  const role = input.role?.trim();

  if (!name) throw new AgentValidationError('Name is required.');
  if (!title) throw new AgentValidationError('Title is required.');
  if (!role || !AGENT_ROLES.includes(role as AgentRole)) {
    throw new AgentValidationError('A valid role is required.');
  }

  const urlKey = slugifyUrlKey(input.urlKey?.trim() || name);
  if (!urlKey) throw new AgentValidationError('Agent ID is required.');
  if (RESERVED_AGENT_IDS.has(urlKey)) {
    throw new AgentValidationError(`Agent ID "${urlKey}" is reserved.`);
  }
  if (!isValidUrlKey(urlKey)) {
    throw new AgentValidationError('Agent ID must use lowercase letters, numbers, and hyphens only.');
  }

  const company = input.companyId
    ? await db.query.companies.findFirst({ where: eq(companies.id, input.companyId) })
    : await getActiveCompany();

  if (!company) throw new AgentValidationError('Company not found.');

  const companyId = company.id;

  const duplicate = await db.query.agents.findFirst({
    where: and(eq(agents.companyId, companyId), eq(agents.urlKey, urlKey)),
  });
  if (duplicate) {
    throw new AgentValidationError(`Agent ID "${urlKey}" is already in use.`);
  }

  if (input.reportsToId) {
    const manager = await db.query.agents.findFirst({
      where: and(eq(agents.id, input.reportsToId), eq(agents.companyId, companyId)),
    });
    if (!manager) throw new AgentValidationError('Reports-to agent not found in this company.');
  }

  const defaultProvider = await newAgentProviderForCompany(companyId);
  const envProvider = resolveModelProviderConfig(null, null, defaultProvider);

  const runtimeType = parseAgentRuntimeType(input.runtimeType) ?? 'agent';
  const { adapterType, adapterConfig } = resolveAdapterFieldsForRuntime(runtimeType);

  let assignedToolsets = [...(ROLE_DEFAULT_TOOLSETS[role] ?? [])];
  if (input.codeExecutionEnabled === false) {
    assignedToolsets = assignedToolsets.filter((id) => id !== 'code-execution');
  } else if (input.codeExecutionEnabled === true && !assignedToolsets.includes('code-execution')) {
    assignedToolsets.push('code-execution');
  }

  const runtimeConfig: AgentRuntimeConfig = {
    ...DEFAULT_RUNTIME_CONFIG,
    assignedTools: ROLE_DEFAULT_ASSIGNED_TOOLS[role] ?? [],
  };

  const assignedSkills = await buildAssignedSkills(companyId, role);

  const [created] = await db
    .insert(agents)
    .values({
      companyId,
      name,
      title,
      role,
      urlKey,
      reportsToId: input.reportsToId ?? null,
      assignedSkills,
      assignedToolsets,
      providerId: defaultProvider?.id ?? null,
      modelId: envProvider.defaultModel,
      adapterType,
      adapterConfig,
      status: 'active',
      runtimeConfig,
      instructionsBundleSoulMd: normalizeInstructionField(input.instructionsBundleSoulMd),
      instructionsBundleAgentsMd: normalizeInstructionField(input.instructionsBundleAgentsMd),
    })
    .returning();

  await seedAgentSkillsFromTemplates(companyId, urlKey);

  return created;
}

export interface CloneAgentInput {
  sourceAgentId: string;
  name: string;
  urlKey: string;
  /** When false, strip agent-level integration secrets from runtimeConfig. Default true. */
  copyCredentials?: boolean;
}

/** Suggest a free company-scoped urlKey like `cto-copy`, `cto-copy-2`, … */
export async function suggestCloneUrlKey(companyId: string, sourceUrlKey: string): Promise<string> {
  const base = `${sourceUrlKey}-copy`;
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const existing = await db.query.agents.findFirst({
      where: and(eq(agents.companyId, companyId), eq(agents.urlKey, candidate)),
    });
    if (!existing) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Clone an agent as a new row with full config (skills, toolsets, model, instructions, MCP).
 * Regenerates id; resets spent tokens; disables automatic heartbeat; copies workspace skills.
 */
export async function cloneAgent(input: CloneAgentInput): Promise<Agent> {
  const source = await db.query.agents.findFirst({ where: eq(agents.id, input.sourceAgentId) });
  if (!source) throw new AgentValidationError('Source agent not found.');

  const name = input.name?.trim();
  if (!name) throw new AgentValidationError('Name is required.');

  const urlKey = slugifyUrlKey(input.urlKey?.trim() || name);
  if (!urlKey) throw new AgentValidationError('Agent ID is required.');
  if (RESERVED_AGENT_IDS.has(urlKey)) {
    throw new AgentValidationError(`Agent ID "${urlKey}" is reserved.`);
  }
  if (!isValidUrlKey(urlKey)) {
    throw new AgentValidationError('Agent ID must use lowercase letters, numbers, and hyphens only.');
  }
  if (urlKey === source.urlKey) {
    throw new AgentValidationError('Clone Agent ID must differ from the source agent.');
  }

  const duplicate = await db.query.agents.findFirst({
    where: and(eq(agents.companyId, source.companyId), eq(agents.urlKey, urlKey)),
  });
  if (duplicate) {
    throw new AgentValidationError(`Agent ID "${urlKey}" is already in use.`);
  }

  await assertAgentProviderOnForCompany(source.companyId, source.providerId);

  const sourceRuntime = source.runtimeConfig as AgentRuntimeConfig;
  const copyCredentials = input.copyCredentials !== false;

  // S297-S4 (explicit decision): the clone INHERITS the source's avatar. `structuredClone`
  // copies `avatar` along with every other runtimeConfig member — copy semantics consistent
  // with the rest of the config (model, heartbeat shape, budgets, …). Only heartbeat is
  // overridden (disabled) and, when copyCredentials=false, agent-level integration secrets are
  // stripped; the avatar is neither. Two clones can be told apart by name/urlKey, and the
  // user can change the clone's avatar on its page (updateAgentAvatar).
  const runtimeConfig: AgentRuntimeConfig = {
    ...structuredClone(sourceRuntime),
    heartbeat: {
      ...sourceRuntime.heartbeat,
      enabled: false,
    },
  };

  if (!copyCredentials) {
    delete runtimeConfig.mcpCredentials;
    delete runtimeConfig.tavilyApiKey;
    delete runtimeConfig.searxngUrl;
    delete runtimeConfig.searxngApiKey;
  }

  const [created] = await db
    .insert(agents)
    .values({
      companyId: source.companyId,
      name,
      title: source.title,
      role: source.role,
      icon: source.icon,
      urlKey,
      reportsToId: source.reportsToId,
      adapterType: source.adapterType,
      adapterConfig: structuredClone(source.adapterConfig ?? {}),
      providerId: source.providerId,
      modelId: source.modelId,
      instructionsBundleSoulMd: source.instructionsBundleSoulMd,
      instructionsBundleAgentsMd: source.instructionsBundleAgentsMd,
      instructionsPath: source.instructionsPath,
      assignedSkills: ensureControlPlaneInSkills([...(source.assignedSkills ?? [])]),
      assignedToolsets: [...(source.assignedToolsets ?? [])],
      mcpServerIds: [...(source.mcpServerIds ?? [])],
      budgetMonthlyTokens: source.budgetMonthlyTokens,
      spentMonthlyTokens: 0,
      status: 'active',
      runtimeConfig,
      defaultBillingCode: source.defaultBillingCode,
    })
    .returning();

  await copyAgentWorkspaceSkills(source.companyId, source.urlKey, urlKey);
  await seedAgentSkillsFromTemplates(source.companyId, urlKey);

  return created;
}

export async function updateAgentRuntimeConfig(
  agentId: string,
  patch: {
    heartbeat?: Partial<AgentRuntimeConfig['heartbeat']>;
    timeout?: Partial<AgentRuntimeConfig['timeout']>;
    model?: AgentRuntimeConfig['model'];
    mail?: AgentRuntimeConfig['mail'];
  }
): Promise<Agent> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  const current = agent.runtimeConfig as AgentRuntimeConfig;
  const mergedHeartbeat = patch.heartbeat
    ? normalizeHeartbeatConfig({ ...current.heartbeat, ...patch.heartbeat })
    : current.heartbeat;

  if (patch.heartbeat) {
    const heartbeatError = validateHeartbeatSchedule(mergedHeartbeat);
    if (heartbeatError) throw new AgentValidationError(heartbeatError);
  }

  // S297-S3: write only the keys this updater owns via one atomic jsonb statement, so a
  // concurrent save of another key (e.g. avatar) can never be dropped by this stale snapshot.
  const set: Record<string, unknown> = {
    // timeout is always rewritten (mirrors the previous whole-object write, which
    // materialised `timeout: {}` on a row missing the key).
    timeout: { ...current.timeout, ...patch.timeout },
  };
  const clear: string[] = [];
  if (patch.heartbeat) set.heartbeat = mergedHeartbeat;
  if (patch.model !== undefined) set.model = patch.model;
  if ('mail' in patch) {
    if (patch.mail === undefined) clear.push('mail');
    else set.mail = patch.mail;
  }

  const updated = await updateAgentRuntimeConfigKeys(agentId, { set, clear }, { updatedAt: new Date() });
  if (!updated) throw new AgentValidationError('Agent not found.');

  if (patch.heartbeat) {
    try {
      const { requestAgentTimerScheduleSync } = await import('./wake-client');
      await requestAgentTimerScheduleSync(updated.id);
    } catch {
      // Scheduler reconciles Mastra schedules on boot if wake server is down.
    }
  }

  return updated;
}

/**
 * AGENT-AVATAR-UI: set or clear the agent's avatar (shape + colour) on `runtimeConfig.avatar`
 * (existing jsonb — no migration). `null` resets to the default avatar. The write only touches
 * the `avatar` key: every other runtimeConfig member is preserved as-is — atomically, via the
 * jsonb merge in `updateAgentRuntimeConfigKeys` (S297-S3), never a whole-document rewrite from
 * this function's (possibly stale) read.
 */
export async function updateAgentAvatar(agentId: string, avatar: AgentAvatarConfig | null): Promise<Agent> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  const updated = await updateAgentRuntimeConfigKeys(
    agentId,
    avatar ? { set: { avatar } } : { clear: ['avatar'] },
    { updatedAt: new Date() },
  );
  if (!updated) throw new AgentValidationError('Agent not found.');

  return updated;
}

export async function updateAgentModelSettings(
  agentId: string,
  patch: AgentModelSettingsPatch,
): Promise<Agent> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  const current = agent.runtimeConfig as AgentRuntimeConfig;
  const merged = applyModelSettingsPatch(current.model, patch);

  try {
    parseAgentModelSettings(merged);
  } catch (err) {
    throw new AgentValidationError(
      err instanceof Error ? err.message : 'Invalid generation settings.',
    );
  }

  // S297-S3: only the `model` key is written (cleared when the patch empties it, matching the
  // previous whole-object write where the `undefined` member was dropped by JSON.stringify);
  // concurrent writes to other runtimeConfig keys survive.
  const updated = await updateAgentRuntimeConfigKeys(
    agentId,
    Object.keys(merged).length > 0 ? { set: { model: merged } } : { clear: ['model'] },
    { updatedAt: new Date() },
  );
  if (!updated) throw new AgentValidationError('Agent not found.');

  invalidateChatControllerForAgent(agentId);

  return updated;
}

export async function updateAgentAssignedToolsets(
  agentId: string,
  toolsets: string[]
): Promise<Agent> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  const unique = [...new Set(toolsets.map((t) => t.trim()).filter(Boolean))];
  const invalid = unique.filter((id) => !VALID_TOOLSET_IDS.has(id));
  if (invalid.length > 0) {
    throw new AgentValidationError(`Unknown toolsets: ${invalid.join(', ')}`);
  }

  const [updated] = await db
    .update(agents)
    .set({ assignedToolsets: unique, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning();

  return updated;
}

export async function updateAgentCapabilities(
  agentId: string,
  input: {
    toolsets: string[];
    assignedTools: string[];
    assignedSkills: string[];
    integrations?: Partial<Record<string, string>>;
    clearIntegrations?: string[];
    /** Explicit MCP server ids enabled for this agent (from mcp.json + builtins). */
    mcpServerIds?: string[];
    /** Per-server allow lists from capabilities UI. Only keys for currently assigned MCP servers are kept. */
    mcpToolPolicy?: Record<string, { allow: string[] }>;
    /** Knowledge-graph mounts when toolset is enabled. */
    knowledgeGraph?: { private: boolean; company: boolean };
    /** `browser` toolset sub-options when the toolset is enabled. */
    browser?: { screenshots: boolean };
  },
): Promise<Agent> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  const company = await db.query.companies.findFirst({
    where: eq(companies.id, agent.companyId),
  });
  if (!company) throw new AgentValidationError('Company not found.');

  const toolsets = [...new Set(input.toolsets.map((t) => t.trim()).filter(Boolean))].filter(
    (id) => id !== 'planning',
  );
  const invalidToolsets = toolsets.filter((id) => !VALID_TOOLSET_IDS.has(id));
  if (invalidToolsets.length > 0) {
    throw new AgentValidationError(`Unknown toolsets: ${invalidToolsets.join(', ')}`);
  }

  const toggleableIds = new Set(
    listToggleableMcpServerDefinitions(company.allowedMcpServerIds ?? []).map((s) => s.id),
  );
  const mcpServerIds = [
    ...new Set((input.mcpServerIds ?? []).map((id) => id.trim()).filter(Boolean)),
  ];
  const invalidMcpServers = mcpServerIds.filter((id) => !toggleableIds.has(id));
  if (invalidMcpServers.length > 0) {
    throw new AgentValidationError(
      `Unknown or disallowed MCP servers: ${invalidMcpServers.join(', ')}`,
    );
  }
  for (const id of mcpServerIds) {
    if (!getMcpServerDefinition(id)) {
      throw new AgentValidationError(`Unknown MCP server: ${id}`);
    }
  }

  const assignedTools = [...new Set(input.assignedTools.map((t) => t.trim()).filter(Boolean))];
  const invalidTools = assignedTools.filter((id) => !VALID_ASSIGNABLE_TOOL_IDS.has(id));
  if (invalidTools.length > 0) {
    throw new AgentValidationError(`Unknown tools: ${invalidTools.join(', ')}`);
  }

  const companySkillSlugs = new Set(await discoverCompanySkillSlugs(agent.companyId));
  const assignedSkills = ensureControlPlaneInSkills([
    ...new Set(input.assignedSkills.map((s) => s.trim()).filter(Boolean)),
  ]);
  const invalidSkills = assignedSkills.filter(
    (slug) => !VALID_BUNDLED_SKILL_IDS.has(slug) && !companySkillSlugs.has(slug),
  );
  if (invalidSkills.length > 0) {
    throw new AgentValidationError(`Unknown skills: ${invalidSkills.join(', ')}`);
  }

  const clearIntegrations = [...new Set((input.clearIntegrations ?? []).map((k) => k.trim()).filter(Boolean))];
  const invalidClears = clearIntegrations.filter((id) => !VALID_AGENT_INTEGRATION_CREDENTIAL_IDS.has(id));
  if (invalidClears.length > 0) {
    throw new AgentValidationError(`Unknown integration keys: ${invalidClears.join(', ')}`);
  }

  const integrations = input.integrations ?? {};
  const invalidSets = Object.keys(integrations).filter((id) => !VALID_AGENT_INTEGRATION_CREDENTIAL_IDS.has(id));
  if (invalidSets.length > 0) {
    throw new AgentValidationError(`Unknown integration keys: ${invalidSets.join(', ')}`);
  }

  const current = agent.runtimeConfig as AgentRuntimeConfig;
  const runtimeConfig: AgentRuntimeConfig = {
    ...current,
    assignedTools,
  };

  const mcpCredentials = { ...current.mcpCredentials };
  // S297-S3: integration keys actually touched by this save (the atomic op set stays minimal).
  const integrationKeysTouched = new Set<string>();

  for (const key of clearIntegrations) {
    if (key === 'tavilyApiKey') { runtimeConfig.tavilyApiKey = undefined; integrationKeysTouched.add('tavilyApiKey'); }
    if (key === 'searxngUrl') { runtimeConfig.searxngUrl = undefined; integrationKeysTouched.add('searxngUrl'); }
    if (key === 'searxngApiKey') { runtimeConfig.searxngApiKey = undefined; integrationKeysTouched.add('searxngApiKey'); }
    if (key === 'bufferApiKey') delete mcpCredentials['buffer-mcp'];
  }

  for (const [key, rawValue] of Object.entries(integrations)) {
    const value = rawValue?.trim();
    if (!value) continue;
    if (key === 'tavilyApiKey') { runtimeConfig.tavilyApiKey = value; integrationKeysTouched.add('tavilyApiKey'); }
    if (key === 'searxngUrl') { runtimeConfig.searxngUrl = value; integrationKeysTouched.add('searxngUrl'); }
    if (key === 'searxngApiKey') { runtimeConfig.searxngApiKey = value; integrationKeysTouched.add('searxngApiKey'); }
    if (key === 'bufferApiKey') mcpCredentials['buffer-mcp'] = value;
  }

  runtimeConfig.mcpCredentials = Object.keys(mcpCredentials).length > 0 ? mcpCredentials : undefined;

  if (input.knowledgeGraph !== undefined) {
    if (toolsets.includes('knowledge-graph')) {
      runtimeConfig.knowledgeGraph = {
        private: input.knowledgeGraph.private,
        company: input.knowledgeGraph.company,
      };
    } else {
      runtimeConfig.knowledgeGraph = undefined;
    }
  } else if (!toolsets.includes('knowledge-graph')) {
    runtimeConfig.knowledgeGraph = undefined;
  }

  runtimeConfig.browser = nextBrowserRuntimeConfig(current.browser, toolsets, input.browser);

  if (input.mcpToolPolicy !== undefined) {
    const assignedServerIds = new Set(
      resolveAgentMcpServerIds({
        assignedToolsets: toolsets,
        mcpServerIds,
        runtimeConfig,
      }),
    );

    const nextPolicy: NonNullable<AgentRuntimeConfig['mcpToolPolicy']> = {};
    for (const serverId of assignedServerIds) {
      const submitted = input.mcpToolPolicy[serverId];
      if (submitted !== undefined) {
        nextPolicy[serverId] = {
          allow: [...new Set(submitted.allow.map((t) => t.trim()).filter(Boolean))],
          ...(current.mcpToolPolicy?.[serverId]?.deny?.length
            ? { deny: current.mcpToolPolicy[serverId]!.deny }
            : {}),
        };
      } else if (current.mcpToolPolicy?.[serverId]) {
        nextPolicy[serverId] = current.mcpToolPolicy[serverId]!;
      }
    }
    runtimeConfig.mcpToolPolicy = Object.keys(nextPolicy).length > 0 ? nextPolicy : undefined;
  }

  // S297-S3: the keys this updater owns are written atomically (single jsonb merge statement)
  // instead of rewriting the whole document from this (possibly stale) read. Keys owned by
  // other updaters — e.g. `avatar`, `heartbeat` — are never touched here, so a concurrent
  // save of one of them is never dropped.
  const runtimeConfigOps = buildCapabilitiesOps(runtimeConfig, {
    integrationKeysTouched,
    knowledgeGraphTouched:
      input.knowledgeGraph !== undefined || !toolsets.includes('knowledge-graph'),
    mcpToolPolicyTouched: input.mcpToolPolicy !== undefined,
  });

  const updated = await updateAgentRuntimeConfigKeys(
    agentId,
    runtimeConfigOps,
    {
      assignedSkills,
      assignedToolsets: toolsets,
      mcpServerIds,
      updatedAt: new Date(),
    },
  );
  if (!updated) throw new AgentValidationError('Agent not found.');

  return updated;
}

/**
 * S297-S3: translate the capability-owned members of the computed runtimeConfig into per-key
 * jsonb ops. An owned member assigned `undefined` becomes a clear (the previous whole-object
 * write dropped `undefined` members via JSON.stringify); owned members never assigned here are
 * left alone entirely (they merely rode along in the old spread).
 */
function buildCapabilitiesOps(
  runtimeConfig: AgentRuntimeConfig,
  touched: { integrationKeysTouched: Set<string>; knowledgeGraphTouched: boolean; mcpToolPolicyTouched: boolean },
): { set: Record<string, unknown>; clear: string[] } {
  const ownedKeys: string[] = ['assignedTools', 'mcpCredentials', 'browser', ...touched.integrationKeysTouched];
  if (touched.knowledgeGraphTouched) ownedKeys.push('knowledgeGraph');
  if (touched.mcpToolPolicyTouched) ownedKeys.push('mcpToolPolicy');
  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  for (const key of ownedKeys) {
    const value = (runtimeConfig as unknown as Record<string, unknown>)[key];
    if (value === undefined) clear.push(key);
    else set[key] = value;
  }
  return { set, clear };
}

export async function updateAgentCodeExecution(
  agentId: string,
  input: {
    runtimeType: AgentRuntimeType;
    codeExecutionEnabled: boolean;
    timeoutMs?: number | null;
    isolation?: string | null;
    allowNetwork?: boolean | null;
    egressAllowList?: string[] | null;
    clearCodeExecutionOverrides?: boolean;
  },
): Promise<Agent> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  const runtimeType = parseAgentRuntimeType(input.runtimeType);
  if (!runtimeType) throw new AgentValidationError('Invalid runtime type.');

  const currentToolsets = agent.assignedToolsets ?? [];
  const withoutCodeExecution = currentToolsets.filter((id) => id !== 'code-execution');
  const assignedToolsets = input.codeExecutionEnabled
    ? [...withoutCodeExecution, 'code-execution']
    : withoutCodeExecution;

  let adapterType = agent.adapterType;
  let adapterConfig = agent.adapterConfig as Record<string, unknown>;
  let runtimeChanged = false;

  if (runtimeType === 'harness') {
    const harnessFields = resolveAdapterFieldsForRuntime('harness');
    if (!isHarnessAdapter(agent.adapterType)) {
      runtimeChanged = true;
    }
    adapterType = harnessFields.adapterType;
    adapterConfig = harnessFields.adapterConfig;
  } else if (isHarnessAdapter(agent.adapterType)) {
    runtimeChanged = true;
    adapterType = defaultAgentAdapterType();
    adapterConfig = {};
  }

  const current = agent.runtimeConfig as AgentRuntimeConfig;
  const runtimeConfig: AgentRuntimeConfig = { ...current };

  try {
    runtimeConfig.codeExecution = applyCodeExecutionOverrides(current.codeExecution, input);
  } catch (err) {
    throw new AgentValidationError(
      err instanceof Error ? err.message : 'Invalid egress allow-list.',
    );
  }

  // Clean up idle threads when switching between Agent and Harness runtimes.
  // This prevents observational memory from rejecting messages with wrong resourceId.
  if (runtimeChanged) {
    await clearIdleThreadOnRuntimeSwitch(agentId);
  }

  // S297-S3: only the `codeExecution` key of runtimeConfig is written, atomically; other keys
  // (avatar, heartbeat, …) are untouched by this save and survive concurrent writes.
  const updated = await updateAgentRuntimeConfigKeys(
    agentId,
    runtimeConfig.codeExecution === undefined ? { clear: ['codeExecution'] } : { set: { codeExecution: runtimeConfig.codeExecution } },
    {
      assignedToolsets,
      adapterType,
      adapterConfig,
      updatedAt: new Date(),
    },
  );
  if (!updated) throw new AgentValidationError('Agent not found.');

  await db.insert(activityLog).values({
    companyId: agent.companyId,
    actorType: 'user',
    actorId: 'dashboard',
    actorName: 'Dashboard',
    action: 'agent.code_execution_updated',
    entityType: 'agent',
    entityId: agent.id,
    details: buildCodeExecutionActivityDetails({
      runtimeType,
      codeExecutionEnabled: input.codeExecutionEnabled,
      before: current.codeExecution,
      after: runtimeConfig.codeExecution,
      clearCodeExecutionOverrides: input.clearCodeExecutionOverrides,
    }),
  });

  return updated;
}

export async function updateAgentInstructions(
  agentId: string,
  input: { soulMd?: string; agentsMd?: string }
): Promise<Agent> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  const patch: {
    instructionsBundleSoulMd?: string | null;
    instructionsBundleAgentsMd?: string | null;
    updatedAt: Date;
  } = { updatedAt: new Date() };

  if (input.soulMd !== undefined) {
    patch.instructionsBundleSoulMd = normalizeInstructionField(input.soulMd);
  }
  if (input.agentsMd !== undefined) {
    patch.instructionsBundleAgentsMd = normalizeInstructionField(input.agentsMd);
  }

  const [updated] = await db
    .update(agents)
    .set(patch)
    .where(eq(agents.id, agentId))
    .returning();

  return updated;
}

export interface UpdateAgentProfileInput {
  name: string;
  title: string;
  urlKey: string;
  reportsToId?: string | null;
}

export async function updateAgentProfile(
  agentId: string,
  input: UpdateAgentProfileInput,
): Promise<Agent> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  const name = input.name?.trim();
  if (!name) throw new AgentValidationError('Name is required.');

  const title = input.title?.trim();
  if (!title) throw new AgentValidationError('Title is required.');

  const urlKey = slugifyUrlKey(input.urlKey?.trim() || '');
  if (!urlKey) throw new AgentValidationError('Agent ID is required.');
  if (RESERVED_AGENT_IDS.has(urlKey)) {
    throw new AgentValidationError(`Agent ID "${urlKey}" is reserved.`);
  }
  if (!isValidUrlKey(urlKey)) {
    throw new AgentValidationError('Agent ID must use lowercase letters, numbers, and hyphens only.');
  }

  if (urlKey !== agent.urlKey) {
    const duplicate = await db.query.agents.findFirst({
      where: and(eq(agents.companyId, agent.companyId), eq(agents.urlKey, urlKey)),
    });
    if (duplicate) {
      throw new AgentValidationError(`Agent ID "${urlKey}" is already in use.`);
    }
  }

  const reportsToId =
    typeof input.reportsToId === 'string' && input.reportsToId.trim()
      ? input.reportsToId.trim()
      : null;

  if (reportsToId === agentId) {
    throw new AgentValidationError('An agent cannot report to themselves.');
  }

  if (reportsToId) {
    const manager = await db.query.agents.findFirst({
      where: and(eq(agents.id, reportsToId), eq(agents.companyId, agent.companyId)),
    });
    if (!manager) throw new AgentValidationError('Reports-to agent not found in this company.');

    const directReport = await db.query.agents.findFirst({
      where: and(eq(agents.id, reportsToId), eq(agents.reportsToId, agentId)),
    });
    if (directReport) {
      throw new AgentValidationError('Cannot report to a direct report — that would create a cycle.');
    }
  }

  const [updated] = await db
    .update(agents)
    .set({ name, title, urlKey, reportsToId, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning();

  return updated;
}

/**
 * Result of an active toggle. `changed` is whether agents.status actually changed. Deactivating an
 * archived agent is a no-op reported as `{ changed: false, reason: 'archived' }` so MCP and mobile
 * can say so instead of claiming success.
 */
export type SetAgentActiveOutcome = { agent: Agent; changed: boolean; reason?: 'archived' };

export async function setAgentActive(agentId: string, active: boolean): Promise<Agent> {
  return (await setAgentActiveWithOutcome(agentId, active)).agent;
}

export async function setAgentActiveWithOutcome(
  agentId: string,
  active: boolean,
): Promise<SetAgentActiveOutcome> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  if (agent.status === 'pending_approval') {
    throw new AgentValidationError('Agent is pending approval and cannot be activated yet.');
  }

  // #119 B1: every active toggle (detail chip, list toggle, MCP set_agent_active, mobile
  // 'active' section) goes through here. Activating an archived agent would revive its run and
  // chat tokens (agent-token-auth refuses only archived agents), so it is refused. Deactivating
  // an archived agent is a no-op: it is already not active, and writing 'paused' would
  // un-archive it one step short of active.
  if (agent.status === 'archived') {
    if (active) {
      throw new AgentValidationError('Agent is archived and cannot be activated.');
    }
    return { agent, changed: false, reason: 'archived' };
  }

  const previousStatus = agent.status;
  const status = active ? 'active' : 'paused';

  const [updated] = await db
    .update(agents)
    .set({ status, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning();

  return { agent: updated, changed: updated.status !== previousStatus };
}

export type AgentStatus = 'active' | 'paused' | 'archived';

/**
 * Set agent status to active, paused, or archived.
 * Enforces safety rules: no mutations on pending_approval, cannot archive last active CEO.
 */
export async function setAgentStatus(
  agentId: string,
  status: AgentStatus,
  options?: { skipLastCeoCheck?: boolean }
): Promise<Agent> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  if (agent.status === 'pending_approval') {
    throw new AgentValidationError('Agent is pending approval and cannot be modified yet.');
  }

  if (!['active', 'paused', 'archived'].includes(status)) {
    throw new AgentValidationError('Invalid status. Must be active, paused, or archived.');
  }

  // #119 B1 parity with setAgentActiveWithOutcome: un-archiving would revive the agent's run and
  // chat tokens (agent-token-auth refuses only archived agents), so archived is terminal here.
  // Re-archiving an archived agent is a no-op.
  if (agent.status === 'archived') {
    if (status !== 'archived') {
      throw new AgentValidationError('Agent is archived and cannot be reactivated or paused.');
    }
    return agent;
  }

  // Prevent archiving or pausing the last active CEO
  if (agent.role === 'ceo' && (status === 'archived' || status === 'paused') && !options?.skipLastCeoCheck) {
    const activeCeos = await db.query.agents.findMany({
      where: and(eq(agents.companyId, agent.companyId), eq(agents.role, 'ceo'), eq(agents.status, 'active')),
    });
    if (activeCeos.length === 1 && activeCeos[0].id === agentId) {
      throw new AgentValidationError('Cannot pause or archive the last active CEO in the company.');
    }
  }

  const [updated] = await db
    .update(agents)
    .set({ status, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning();

  return updated;
}

export async function updateAgentRole(agentId: string, roleInput: string): Promise<Agent> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  const role = roleInput?.trim();
  if (!role || !AGENT_ROLES.includes(role as AgentRole)) {
    throw new AgentValidationError('A valid role is required.');
  }

  if (role === agent.role) {
    return agent;
  }

  const assignedSkills = await buildAssignedSkills(agent.companyId, role);

  // S297-S3: role defaults land on the single `assignedTools` key via an atomic jsonb write;
  // concurrent saves of other runtimeConfig keys (e.g. avatar) are never clobbered.
  const updated = await updateAgentRuntimeConfigKeys(
    agentId,
    { set: { assignedTools: ROLE_DEFAULT_ASSIGNED_TOOLS[role] ?? [] } },
    {
      role,
      assignedSkills,
      assignedToolsets: ROLE_DEFAULT_TOOLSETS[role] ?? [],
      updatedAt: new Date(),
    },
  );
  if (!updated) throw new AgentValidationError('Agent not found.');

  return updated;
}

export async function deleteAgent(agentId: string, confirmUrlKey: string): Promise<void> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  const confirmation = confirmUrlKey?.trim();
  if (!confirmation || confirmation !== agent.urlKey) {
    throw new AgentValidationError(
      `Type "${agent.urlKey}" to confirm deletion.`,
    );
  }

  const directReports = await db.query.agents.findMany({
    where: eq(agents.reportsToId, agentId),
  });
  if (directReports.length > 0) {
    const names = directReports.map((r) => r.name).join(', ');
    throw new AgentValidationError(
      `Cannot delete agent with direct reports (${names}). Reassign them first.`,
    );
  }

  await db.delete(agents).where(eq(agents.id, agentId));
}

export {
  getAgentHeartbeatSummary,
  type AgentHeartbeatSummary,
} from './agent-heartbeat-summary';

export async function updateAgentModel(
  agentId: string,
  input: { modelId: string; providerId?: string | null },
): Promise<Agent> {
  const trimmed = input.modelId?.trim();
  if (!trimmed) throw new AgentValidationError('Model ID is required.');

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  const patch: {
    modelId: string;
    providerId?: string | null;
    updatedAt: Date;
  } = {
    modelId: trimmed,
    updatedAt: new Date(),
  };

  if (input.providerId !== undefined) {
    patch.providerId = input.providerId?.trim() ? input.providerId.trim() : null;
    await assertAgentProviderOnForCompany(agent.companyId, patch.providerId);
  }

  const [updated] = await db
    .update(agents)
    .set(patch)
    .where(eq(agents.id, agentId))
    .returning();

  invalidateChatControllerForAgent(agentId);

  return updated;
}

export async function updateAgentBudget(
  agentId: string,
  input: { budgetMonthlyTokens: number; enforce: boolean },
): Promise<Agent> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  const budgetMonthlyTokens = input.budgetMonthlyTokens;
  if (!Number.isInteger(budgetMonthlyTokens) || budgetMonthlyTokens < 0) {
    throw new AgentValidationError('Monthly token budget must be a non-negative integer.');
  }

  const current = agent.runtimeConfig as AgentRuntimeConfig;

  // S297-S3: only the `budget` key is written, atomically (row-level columns alongside).
  const updated = await updateAgentRuntimeConfigKeys(
    agentId,
    { set: { budget: { ...current.budget, enforce: input.enforce } } },
    { budgetMonthlyTokens, updatedAt: new Date() },
  );
  if (!updated) throw new AgentValidationError('Agent not found.');

  return updated;
}

export interface UpdateAgentObservationalMemoryInput {
  mode: 'inherit' | 'off' | 'on';
  providerId?: string;
  modelId?: string;
  maxOutputTokens?: number;
  observeAfterTokens?: number;
  reflectAfterTokens?: number;
  temperature?: number;
}

export async function updateAgentObservationalMemory(
  agentId: string,
  input: UpdateAgentObservationalMemoryInput,
): Promise<Agent> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  // Validate mode
  if (!['inherit', 'off', 'on'].includes(input.mode)) {
    throw new AgentValidationError('Invalid mode. Must be inherit, off, or on.');
  }

  await assertAgentProviderOnForCompany(agent.companyId, input.providerId?.trim() || null);

  // Validate integer thresholds
  if (input.maxOutputTokens !== undefined) {
    if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1024) {
      throw new AgentValidationError('Max output tokens must be at least 1024.');
    }
  }
  if (input.observeAfterTokens !== undefined) {
    if (!Number.isInteger(input.observeAfterTokens) || input.observeAfterTokens < 8000) {
      throw new AgentValidationError('Observe after tokens must be at least 8000.');
    }
  }
  if (input.reflectAfterTokens !== undefined) {
    if (!Number.isInteger(input.reflectAfterTokens) || input.reflectAfterTokens < 8000) {
      throw new AgentValidationError('Reflect after tokens must be at least 8000.');
    }
  }
  if (input.temperature !== undefined) {
    if (typeof input.temperature !== 'number' || input.temperature < 0 || input.temperature > 2) {
      throw new AgentValidationError('Temperature must be between 0 and 2.');
    }
  }

  // For mode=on, require resolvable model (agent or company)
  if (input.mode === 'on') {
    const hasAgentModel = input.providerId?.trim() && input.modelId?.trim();
    if (!hasAgentModel) {
      // Check if company has a model to inherit
      const company = await db.query.companies.findFirst({
        where: eq(companies.id, agent.companyId),
      });
      const companyOm = (company?.settings as { observationalMemory?: { providerId?: string; modelId?: string } })?.observationalMemory;
      const hasCompanyModel = companyOm?.providerId?.trim() && companyOm?.modelId?.trim();
      if (!hasCompanyModel) {
        throw new AgentValidationError(
          'mode=on requires providerId and modelId on the agent or company settings.',
        );
      }
    }
  }

  const observationalMemory: AgentRuntimeConfig['observationalMemory'] = {
    mode: input.mode,
  };

  if (input.providerId?.trim()) {
    observationalMemory.providerId = input.providerId.trim();
  }
  if (input.modelId?.trim()) {
    observationalMemory.modelId = input.modelId.trim();
  }
  if (input.maxOutputTokens !== undefined) {
    observationalMemory.maxOutputTokens = input.maxOutputTokens;
  }
  if (input.observeAfterTokens !== undefined) {
    observationalMemory.observeAfterTokens = input.observeAfterTokens;
  }
  if (input.reflectAfterTokens !== undefined) {
    observationalMemory.reflectAfterTokens = input.reflectAfterTokens;
  }
  if (input.temperature !== undefined) {
    observationalMemory.temperature = input.temperature;
  }

  // S297-S3: only the `observationalMemory` key is written, atomically.
  const updated = await updateAgentRuntimeConfigKeys(
    agentId,
    { set: { observationalMemory } },
    { updatedAt: new Date() },
  );
  if (!updated) throw new AgentValidationError('Agent not found.');

  invalidateChatControllerForAgent(agentId);

  return updated;
}

/**
 * AC-B1.3: Set or rotate agent secrets/environment variables.
 * Values are write-only after save (never redisplayed).
 * Changes take effect on next agent wake.
 */
export interface UpdateAgentSecretsInput {
  /** Key-value pairs to set or update. */
  secrets: Record<string, string>;
  /** When true, replaces all secrets. When false, merges with existing. */
  replace?: boolean;
}

export async function updateAgentSecrets(
  agentId: string,
  input: UpdateAgentSecretsInput,
): Promise<Agent> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  // Validate secrets format
  for (const [key, value] of Object.entries(input.secrets)) {
    if (typeof key !== 'string' || !key.trim()) {
      throw new AgentValidationError('Secret keys must be non-empty strings.');
    }
    if (typeof value !== 'string') {
      throw new AgentValidationError('Secret values must be strings.');
    }
    // Validate key format (standard env var naming)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key.trim())) {
      throw new AgentValidationError(
        `Invalid secret key "${key}". Keys must start with a letter or underscore, and contain only letters, numbers, and underscores.`
      );
    }
  }

  const current = agent.runtimeConfig as AgentRuntimeConfig;
  const existingSecrets = current.secrets ?? {};

  const secrets = input.replace
    ? input.secrets
    : { ...existingSecrets, ...input.secrets };

  // Normalize secrets: trim keys, remove empty values
  const normalizedSecrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets)) {
    const trimmedKey = key.trim();
    const trimmedValue = value.trim();
    if (trimmedKey && trimmedValue) {
      normalizedSecrets[trimmedKey] = trimmedValue;
    }
  }

  // S297-S3: only the `secrets` key is written (cleared when emptied, matching the previous
  // whole-object write that dropped the `undefined` member); other runtimeConfig keys survive
  // concurrent saves. Merging *inside* `secrets` still reads a snapshot — a concurrent write
  // of a different secret key can be lost until secrets get their own sub-key merge.
  const updated = await updateAgentRuntimeConfigKeys(
    agentId,
    Object.keys(normalizedSecrets).length > 0
      ? { set: { secrets: normalizedSecrets } }
      : { clear: ['secrets'] },
    { updatedAt: new Date() },
  );
  if (!updated) throw new AgentValidationError('Agent not found.');

  return updated;
}

/**
 * AC-B1.3: Delete specific secret keys from an agent.
 */
export async function deleteAgentSecrets(
  agentId: string,
  keys: string[],
): Promise<Agent> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  const current = agent.runtimeConfig as AgentRuntimeConfig;
  const existingSecrets = current.secrets ?? {};

  const secrets = { ...existingSecrets };
  for (const key of keys) {
    delete secrets[key.trim()];
  }

  // S297-S3: single-key atomic write (see updateAgentSecrets for the intra-key caveat).
  const updated = await updateAgentRuntimeConfigKeys(
    agentId,
    Object.keys(secrets).length > 0 ? { set: { secrets } } : { clear: ['secrets'] },
    { updatedAt: new Date() },
  );
  if (!updated) throw new AgentValidationError('Agent not found.');

  return updated;
}
