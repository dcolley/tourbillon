import {
  db,
  agents,
  llmProviders,
  getDefaultLlmProviderRow,
  getLlmProviderRowById,
  listLlmProviderRows,
  type LlmProvider,
} from '@tourbillon/db';
import { eq, ne } from 'drizzle-orm';
import {
  defaultBaseURLForProviderType,
  defaultProviderSeedName,
  parseHeaders,
  parseLlmProviderType,
  parseModelApiMode,
  resolveModelProviderConfigFromEnv,
  toLlmProviderRecord,
  type AgentModelSettings,
  parseAgentModelSettings,
  type LlmProviderRecord,
  type LlmProviderType,
} from '@tourbillon/shared';

export class LlmProviderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmProviderValidationError';
  }
}

export interface LlmProviderPublic {
  id: string;
  name: string;
  type: LlmProviderType;
  baseURL: string;
  hasApiKey: boolean;
  headers: Record<string, string>;
  apiMode: 'chat' | 'responses';
  isDefault: boolean;
  defaultModelSettings: AgentModelSettings;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLlmProviderInput {
  name: string;
  type: string;
  baseURL: string;
  apiKey?: string | null;
  headers?: Record<string, string>;
  apiMode?: string;
  isDefault?: boolean;
  defaultModelSettings?: AgentModelSettings;
}

export interface UpdateLlmProviderInput {
  name?: string;
  type?: string;
  baseURL?: string;
  apiKey?: string | null;
  headers?: Record<string, string>;
  apiMode?: string;
  isDefault?: boolean;
  clearApiKey?: boolean;
  defaultModelSettings?: AgentModelSettings;
}

function toPublic(row: LlmProvider): LlmProviderPublic {
  const record = toLlmProviderRecord(row);
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    baseURL: record.baseURL,
    hasApiKey: Boolean(record.apiKey),
    headers: record.headers,
    apiMode: record.apiMode,
    isDefault: record.isDefault,
    defaultModelSettings: record.defaultModelSettings,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function validateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new LlmProviderValidationError('Provider name is required.');
  return trimmed;
}

function validateBaseURL(baseURL: string): string {
  const trimmed = baseURL.trim();
  if (!trimmed) throw new LlmProviderValidationError('Base URL is required.');
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new LlmProviderValidationError('Base URL must use http or https.');
    }
  } catch {
    throw new LlmProviderValidationError('Base URL must be a valid URL.');
  }
  return trimmed.replace(/\/$/, '') === trimmed ? trimmed : trimmed.replace(/\/$/, '');
}

function parseProviderType(type: string): LlmProviderType {
  const parsed = parseLlmProviderType(type);
  if (!parsed) {
    throw new LlmProviderValidationError(
      'Provider type must be one of: lmstudio, ollama, vllm, openai, openai-compatible.',
    );
  }
  return parsed;
}

function validateDefaultModelSettings(settings?: AgentModelSettings): AgentModelSettings {
  if (!settings) return {};
  try {
    return parseAgentModelSettings(settings);
  } catch (err) {
    throw new LlmProviderValidationError(
      err instanceof Error ? err.message : 'Invalid default generation settings.',
    );
  }
}

async function clearOtherDefaults(exceptId?: string): Promise<void> {
  if (exceptId) {
    await db
      .update(llmProviders)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(ne(llmProviders.id, exceptId));
  } else {
    await db.update(llmProviders).set({ isDefault: false, updatedAt: new Date() });
  }
}

/** Seed a default provider from env when the registry is empty. */
export async function ensureDefaultLlmProviders(): Promise<void> {
  const existing = await listLlmProviderRows();
  if (existing.length > 0) return;

  const envConfig = resolveModelProviderConfigFromEnv();
  const type = parseLlmProviderType(envConfig.provider) ?? 'lmstudio';

  await db.insert(llmProviders).values({
    name: defaultProviderSeedName(type),
    type,
    baseURL: envConfig.baseURL,
    apiKey: envConfig.apiKey || null,
    headers: envConfig.headers,
    apiMode: envConfig.apiMode,
    isDefault: true,
  });
}

export async function listLlmProvidersPublic(): Promise<LlmProviderPublic[]> {
  await ensureDefaultLlmProviders();
  const rows = await listLlmProviderRows();
  return rows.map(toPublic);
}

export async function getLlmProviderPublic(id: string): Promise<LlmProviderPublic | null> {
  await ensureDefaultLlmProviders();
  const row = await getLlmProviderRowById(id);
  return row ? toPublic(row) : null;
}

export async function getDefaultLlmProviderRecord(): Promise<LlmProviderRecord | null> {
  await ensureDefaultLlmProviders();
  const row = await getDefaultLlmProviderRow();
  return row ? toLlmProviderRecord(row) : null;
}

export async function getLlmProviderRecordById(id: string): Promise<LlmProviderRecord | null> {
  await ensureDefaultLlmProviders();
  const row = await getLlmProviderRowById(id);
  return row ? toLlmProviderRecord(row) : null;
}

export async function createLlmProvider(input: CreateLlmProviderInput): Promise<LlmProviderPublic> {
  await ensureDefaultLlmProviders();

  const name = validateName(input.name);
  const type = parseProviderType(input.type);
  const baseURL = validateBaseURL(input.baseURL || defaultBaseURLForProviderType(type));
  const apiMode = parseModelApiMode(input.apiMode) ?? 'chat';
  const headers = input.headers ?? {};
  const isDefault = input.isDefault ?? false;
  const defaultModelSettings = validateDefaultModelSettings(input.defaultModelSettings);

  if (isDefault) {
    await clearOtherDefaults();
  }

  const [created] = await db
    .insert(llmProviders)
    .values({
      name,
      type,
      baseURL,
      apiKey: input.apiKey?.trim() ? input.apiKey.trim() : null,
      headers,
      apiMode,
      isDefault,
      defaultModelSettings,
    })
    .returning();

  return toPublic(created);
}

export async function updateLlmProvider(
  id: string,
  input: UpdateLlmProviderInput,
): Promise<LlmProviderPublic> {
  const existing = await getLlmProviderRowById(id);
  if (!existing) throw new LlmProviderValidationError('Provider not found.');

  const updates: Partial<typeof llmProviders.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (input.name !== undefined) updates.name = validateName(input.name);
  if (input.type !== undefined) updates.type = parseProviderType(input.type);
  if (input.baseURL !== undefined) updates.baseURL = validateBaseURL(input.baseURL);
  if (input.headers !== undefined) updates.headers = input.headers;
  if (input.apiMode !== undefined) {
    const apiMode = parseModelApiMode(input.apiMode);
    if (!apiMode) throw new LlmProviderValidationError('API mode must be chat or responses.');
    updates.apiMode = apiMode;
  }

  if (input.clearApiKey) {
    updates.apiKey = null;
  } else if (input.apiKey !== undefined) {
    updates.apiKey = input.apiKey?.trim() ? input.apiKey.trim() : null;
  }

  if (input.isDefault === true) {
    await clearOtherDefaults(id);
    updates.isDefault = true;
  } else   if (input.isDefault === false) {
    updates.isDefault = false;
  }

  if (input.defaultModelSettings !== undefined) {
    updates.defaultModelSettings = validateDefaultModelSettings(input.defaultModelSettings);
  }

  const [updated] = await db
    .update(llmProviders)
    .set(updates)
    .where(eq(llmProviders.id, id))
    .returning();

  if (!updated) throw new LlmProviderValidationError('Provider not found.');

  const stillHasDefault = await getDefaultLlmProviderRow();
  if (!stillHasDefault) {
    await db
      .update(llmProviders)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(llmProviders.id, id));
    const refreshed = await getLlmProviderRowById(id);
    if (!refreshed) throw new LlmProviderValidationError('Provider not found.');
    return toPublic(refreshed);
  }

  return toPublic(updated);
}

export async function deleteLlmProvider(id: string): Promise<void> {
  const existing = await getLlmProviderRowById(id);
  if (!existing) throw new LlmProviderValidationError('Provider not found.');

  const referencingAgents = await db.query.agents.findMany({
    where: eq(agents.providerId, id),
    columns: { id: true, name: true },
  });

  if (referencingAgents.length > 0) {
    const names = referencingAgents.map((a) => a.name).join(', ');
    throw new LlmProviderValidationError(
      `Cannot delete provider — still used by agents: ${names}.`,
    );
  }

  await db.delete(llmProviders).where(eq(llmProviders.id, id));

  if (existing.isDefault) {
    const remaining = await listLlmProviderRows();
    if (remaining.length > 0) {
      await db
        .update(llmProviders)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(llmProviders.id, remaining[0].id));
    }
  }
}

export function parseHeadersFromForm(value: FormDataEntryValue | null): Record<string, string> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parseHeaders(parsed);
  } catch {
    throw new LlmProviderValidationError('Additional headers must be valid JSON.');
  }
}
