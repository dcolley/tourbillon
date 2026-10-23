/**
 * PRV-1: per-company provider enablement.
 *
 * A provider is on for a company unless a `company_llm_providers` row says `enabled = false`,
 * so companies created before PRV-1 (and companies nobody has configured) see every provider.
 * Provider level only: per-model switches are a later story (PRV-2).
 */
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { db } from './client';
import type * as schema from './schema/index';
import { activityLog } from './schema/activity-log';
import {
  companyLlmProviders,
  llmProviders,
  type CompanyLlmProvider,
  type LlmProvider,
} from './schema/llm-providers';

/** Any Drizzle Postgres database over this schema (the app pool, or an in-memory one in tests). */
export type CompanyLlmProviderDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const defaultDb = db as unknown as CompanyLlmProviderDb;

/** Thrown when a run needs a provider but every provider is switched off for the company. */
export class NoEnabledLlmProviderError extends Error {
  readonly companyId: string;
  readonly requestedProviderId: string | null;

  constructor(companyId: string, requestedProviderId: string | null) {
    super(
      'No LLM provider is enabled for this company. Switch one on in Settings → LLM providers.',
    );
    this.name = 'NoEnabledLlmProviderError';
    this.companyId = companyId;
    this.requestedProviderId = requestedProviderId;
  }
}

/** The company's explicit switches. Providers without a row are on. */
export async function listCompanyLlmProviderSettings(
  companyId: string,
  database: CompanyLlmProviderDb = defaultDb,
): Promise<CompanyLlmProvider[]> {
  return database
    .select()
    .from(companyLlmProviders)
    .where(eq(companyLlmProviders.companyId, companyId));
}

/** Ids of providers switched off for the company. */
export async function listDisabledLlmProviderIds(
  companyId: string,
  database: CompanyLlmProviderDb = defaultDb,
): Promise<Set<string>> {
  const rows = await database
    .select({ providerId: companyLlmProviders.providerId })
    .from(companyLlmProviders)
    .where(
      and(eq(companyLlmProviders.companyId, companyId), eq(companyLlmProviders.enabled, false)),
    );
  return new Set(rows.map((r) => r.providerId));
}

export async function isLlmProviderEnabledForCompany(
  companyId: string,
  providerId: string,
  database: CompanyLlmProviderDb = defaultDb,
): Promise<boolean> {
  const [row] = await database
    .select({ enabled: companyLlmProviders.enabled })
    .from(companyLlmProviders)
    .where(
      and(
        eq(companyLlmProviders.companyId, companyId),
        eq(companyLlmProviders.providerId, providerId),
      ),
    )
    .limit(1);
  return row ? row.enabled : true;
}

export type LlmProviderToggleActor = {
  actorType: 'user' | 'system';
  actorId: string;
  actorName?: string | null;
};

/**
 * Switch a provider on or off for one company and write one activity row, in one transaction.
 * Returns null when the provider does not exist.
 */
export async function setCompanyLlmProviderEnabled(
  input: {
    companyId: string;
    providerId: string;
    enabled: boolean;
    actor: LlmProviderToggleActor;
  },
  database: CompanyLlmProviderDb = defaultDb,
): Promise<{ setting: CompanyLlmProvider; provider: LlmProvider; changed: boolean } | null> {
  const { companyId, providerId, enabled, actor } = input;
  return database.transaction(async (tx) => {
    const [provider] = await tx
      .select()
      .from(llmProviders)
      .where(eq(llmProviders.id, providerId))
      .limit(1);
    if (!provider) return null;

    const [previous] = await tx
      .select({ enabled: companyLlmProviders.enabled })
      .from(companyLlmProviders)
      .where(
        and(
          eq(companyLlmProviders.companyId, companyId),
          eq(companyLlmProviders.providerId, providerId),
        ),
      )
      .limit(1);
    const wasEnabled = previous ? previous.enabled : true;

    const now = new Date();
    const [setting] = await tx
      .insert(companyLlmProviders)
      .values({ companyId, providerId, enabled, updatedBy: actor.actorId, updatedAt: now })
      .onConflictDoUpdate({
        target: [companyLlmProviders.companyId, companyLlmProviders.providerId],
        set: { enabled, updatedBy: actor.actorId, updatedAt: now },
      })
      .returning();

    await tx.insert(activityLog).values({
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorName: actor.actorName ?? null,
      action: enabled ? 'llm_provider.enabled_for_company' : 'llm_provider.disabled_for_company',
      entityType: 'llm_provider',
      entityId: providerId,
      details: { providerId, providerName: provider.name, enabled, previousEnabled: wasEnabled },
    });

    return { setting, provider, changed: wasEnabled !== enabled };
  });
}

export type CompanyProviderChoice =
  /** The agent has no provider set: unchanged pre-PRV-1 behaviour (env / registry default). */
  | { kind: 'unassigned' }
  /** The agent's provider id no longer exists: unchanged pre-PRV-1 behaviour (treated as unset). */
  | { kind: 'missing'; requestedProviderId: string }
  | { kind: 'requested'; providerId: string }
  | { kind: 'fallback'; providerId: string; requestedProviderId: string }
  | { kind: 'none'; requestedProviderId: string };

/**
 * Pure choice of the provider a run uses for a company.
 *
 * - Requested provider on → use it.
 * - Requested provider off → the default provider (`isDefault`) if it is on for the company,
 *   else the first provider still on (by name).
 * - Nothing on → `none` (callers fail the run with {@link NoEnabledLlmProviderError}).
 */
export function chooseCompanyLlmProvider(input: {
  requestedProviderId: string | null | undefined;
  providers: Array<Pick<LlmProvider, 'id' | 'name' | 'isDefault'>>;
  disabledProviderIds: ReadonlySet<string>;
}): CompanyProviderChoice {
  const { requestedProviderId, providers, disabledProviderIds } = input;
  if (!requestedProviderId) return { kind: 'unassigned' };
  if (!providers.some((p) => p.id === requestedProviderId)) {
    return { kind: 'missing', requestedProviderId };
  }
  if (!disabledProviderIds.has(requestedProviderId)) {
    return { kind: 'requested', providerId: requestedProviderId };
  }
  const enabled = providers
    .filter((p) => !disabledProviderIds.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const fallback = enabled.find((p) => p.isDefault) ?? enabled[0];
  if (!fallback) return { kind: 'none', requestedProviderId };
  return { kind: 'fallback', providerId: fallback.id, requestedProviderId };
}

export type ResolvedCompanyLlmProvider = {
  /** Provider row the run uses; null keeps the pre-PRV-1 env / default path. */
  row: LlmProvider | null;
  /** Set when the agent's provider was off and the run moved to `row`. */
  fallbackFrom: LlmProvider | null;
};

/**
 * Provider row a run (heartbeat or chat) uses for an agent in a company, honouring the
 * company's switches. Throws {@link NoEnabledLlmProviderError} when nothing is on.
 */
export async function resolveCompanyLlmProviderRow(
  companyId: string,
  requestedProviderId: string | null | undefined,
  database: CompanyLlmProviderDb = defaultDb,
): Promise<ResolvedCompanyLlmProvider> {
  if (!requestedProviderId) return { row: null, fallbackFrom: null };
  const [providers, disabled] = await Promise.all([
    database.select().from(llmProviders).orderBy(asc(llmProviders.name)),
    listDisabledLlmProviderIds(companyId, database),
  ]);
  const choice = chooseCompanyLlmProvider({
    requestedProviderId,
    providers,
    disabledProviderIds: disabled,
  });
  const byId = (id: string) => providers.find((p) => p.id === id) ?? null;
  switch (choice.kind) {
    case 'unassigned':
    case 'missing':
      return { row: null, fallbackFrom: null };
    case 'requested':
      return { row: byId(choice.providerId), fallbackFrom: null };
    case 'fallback':
      return { row: byId(choice.providerId), fallbackFrom: byId(choice.requestedProviderId) };
    case 'none':
      throw new NoEnabledLlmProviderError(companyId, requestedProviderId);
  }
}

/** Text used wherever a save onto a switched-off provider is refused. */
export function llmProviderDisabledForCompanyMessage(providerName: string): string {
  return `The LLM provider "${providerName}" is switched off for this company. Pick another provider, or switch it on in Settings → LLM providers.`;
}

/** Thrown when an agent would be saved onto a provider that is switched off for its company. */
export class LlmProviderDisabledForCompanyError extends Error {
  readonly companyId: string;
  readonly providerId: string;
  readonly providerName: string;

  constructor(companyId: string, providerId: string, providerName: string) {
    super(llmProviderDisabledForCompanyMessage(providerName));
    this.name = 'LlmProviderDisabledForCompanyError';
    this.companyId = companyId;
    this.providerId = providerId;
    this.providerName = providerName;
  }
}

/**
 * Refuse a provider that is switched off for the company.
 * No-op for an empty id or an id that does not exist (existing behaviour for those).
 */
export async function assertLlmProviderEnabledForCompany(
  companyId: string,
  providerId: string | null | undefined,
  database: CompanyLlmProviderDb = defaultDb,
): Promise<void> {
  if (!providerId) return;
  const [provider] = await database
    .select({ id: llmProviders.id, name: llmProviders.name })
    .from(llmProviders)
    .where(eq(llmProviders.id, providerId))
    .limit(1);
  if (!provider) return;
  if (await isLlmProviderEnabledForCompany(companyId, providerId, database)) return;
  throw new LlmProviderDisabledForCompanyError(companyId, provider.id, provider.name);
}

const FALLBACK_ACTION = 'llm_provider.fallback';
const TOGGLE_ACTIONS = ['llm_provider.enabled_for_company', 'llm_provider.disabled_for_company'];

/**
 * Activity warning when a run moved off a provider that is switched off for the company.
 *
 * Written once per agent per provider change, not once per run or chat turn: skipped when the
 * agent's latest warning has the same from/to providers and the `from` provider has not been
 * switched on or off for the company since. Returns true when a row was written.
 */
export async function recordLlmProviderFallback(
  input: {
    companyId: string;
    agentId: string;
    agentName?: string | null;
    from: Pick<LlmProvider, 'id' | 'name'>;
    to: Pick<LlmProvider, 'id' | 'name'>;
    context: 'heartbeat' | 'chat';
    runId?: string | null;
  },
  database: CompanyLlmProviderDb = defaultDb,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    // Serialise concurrent chat and heartbeat runs for the same agent.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`llm_provider.fallback:${input.agentId}`}))`);

    const [last] = await tx
      .select({ createdAt: activityLog.createdAt, details: activityLog.details })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, input.companyId),
          eq(activityLog.action, FALLBACK_ACTION),
          eq(activityLog.entityType, 'agent'),
          eq(activityLog.entityId, input.agentId),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1);

    if (last) {
      const details = (last.details ?? {}) as { fromProviderId?: unknown; toProviderId?: unknown };
      const samePair = details.fromProviderId === input.from.id && details.toProviderId === input.to.id;
      if (samePair) {
        const [toggled] = await tx
          .select({ id: activityLog.id })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, input.companyId),
              inArray(activityLog.action, TOGGLE_ACTIONS),
              eq(activityLog.entityType, 'llm_provider'),
              eq(activityLog.entityId, input.from.id),
              gte(activityLog.createdAt, last.createdAt),
            ),
          )
          .limit(1);
        if (!toggled) return false;
      }
    }

    await tx.insert(activityLog).values({
      companyId: input.companyId,
      actorType: 'system',
      actorId: 'llm-provider-resolver',
      actorName: 'Provider check',
      action: FALLBACK_ACTION,
      entityType: 'agent',
      entityId: input.agentId,
      details: {
        level: 'warning',
        message: `${input.from.name} is switched off for this company; ${input.agentName ?? 'the agent'} ran on ${input.to.name} instead.`,
        fromProviderId: input.from.id,
        fromProviderName: input.from.name,
        toProviderId: input.to.id,
        toProviderName: input.to.name,
        context: input.context,
        ...(input.runId ? { runId: input.runId } : {}),
      },
    });
    return true;
  });
}
