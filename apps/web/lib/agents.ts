import { db, agents, companies, type Agent } from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';
import {
  ROLE_DEFAULT_SKILLS,
  ROLE_DEFAULT_TOOLSETS,
  DEFAULT_RUNTIME_CONFIG,
  VALID_TOOLSET_IDS,
  defaultAgentAdapterType,
  resolveModelProviderConfig,
  type AgentRuntimeConfig,
} from '@tourbillon/shared';
import { getOrCreateDefaultCompany } from './company';

const AGENT_ROLES = ['ceo', 'cto', 'engineer', 'pm', 'qa', 'designer', 'custom'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** Reserved path segments — cannot be used as agent IDs in /agent/:id URLs */
const RESERVED_AGENT_IDS = new Set(['new']);

export async function getAgentByUrlKey(urlKey: string): Promise<Agent | null> {
  const normalized = urlKey?.trim();
  if (!normalized || RESERVED_AGENT_IDS.has(normalized)) return null;

  const company = await getOrCreateDefaultCompany();
  return (
    (await db.query.agents.findFirst({
      where: and(eq(agents.companyId, company.id), eq(agents.urlKey, normalized)),
    })) ?? null
  );
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
}

function normalizeInstructionField(value: string | undefined | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
    : await getOrCreateDefaultCompany();

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

  const envProvider = resolveModelProviderConfig();

  const [created] = await db
    .insert(agents)
    .values({
      companyId,
      name,
      title,
      role,
      urlKey,
      reportsToId: input.reportsToId ?? null,
      assignedSkills: ROLE_DEFAULT_SKILLS[role] ?? ['control-plane'],
      assignedToolsets: ROLE_DEFAULT_TOOLSETS[role] ?? [],
      modelId: envProvider.defaultModel,
      adapterType: defaultAgentAdapterType(),
      status: 'active',
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      instructionsBundleSoulMd: normalizeInstructionField(input.instructionsBundleSoulMd),
      instructionsBundleAgentsMd: normalizeInstructionField(input.instructionsBundleAgentsMd),
    })
    .returning();

  return created;
}

export async function updateAgentRuntimeConfig(
  agentId: string,
  patch: {
    heartbeat?: Partial<AgentRuntimeConfig['heartbeat']>;
    timeout?: Partial<AgentRuntimeConfig['timeout']>;
    model?: AgentRuntimeConfig['model'];
  }
): Promise<Agent> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  const current = agent.runtimeConfig as AgentRuntimeConfig;
  const runtimeConfig: AgentRuntimeConfig = {
    ...current,
    ...patch,
    heartbeat: { ...current.heartbeat, ...patch.heartbeat },
    timeout: { ...current.timeout, ...patch.timeout },
    model: patch.model !== undefined ? patch.model : current.model,
  };

  const [updated] = await db
    .update(agents)
    .set({ runtimeConfig, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning();

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
    .set({ name, urlKey, reportsToId, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning();

  return updated;
}

export async function setAgentActive(agentId: string, active: boolean): Promise<Agent> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  if (agent.status === 'pending_approval') {
    throw new AgentValidationError('Agent is pending approval and cannot be activated yet.');
  }

  const status = active ? 'active' : 'paused';

  const [updated] = await db
    .update(agents)
    .set({ status, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning();

  return updated;
}

export {
  getAgentHeartbeatSummary,
  type AgentHeartbeatSummary,
} from './agent-heartbeat-summary';

export async function updateAgentModel(agentId: string, modelId: string): Promise<Agent> {
  const trimmed = modelId?.trim();
  if (!trimmed) throw new AgentValidationError('Model ID is required.');

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) throw new AgentValidationError('Agent not found.');

  const [updated] = await db
    .update(agents)
    .set({ modelId: trimmed, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning();

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
  const runtimeConfig: AgentRuntimeConfig = {
    ...current,
    budget: { ...current.budget, enforce: input.enforce },
  };

  const [updated] = await db
    .update(agents)
    .set({
      budgetMonthlyTokens,
      runtimeConfig,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agentId))
    .returning();

  return updated;
}
