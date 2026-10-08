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
  parseStickinessType,
  resolveModelProviderConfigFromEnv,
  toLlmProviderRecord,
  type AgentModelSettings,
  parseAgentModelSettings,
  type LlmProviderRecord,
  type LlmProviderType,
} from '@tourbillon/shared';
import { envProviderConfigured } from './env-provider';
import {
  BASE_URL_CREDENTIALS_MESSAGE,
  baseURLHasCredentials,
  redactBaseURL,
  sameCredentialBoundary,
} from './provider-safety';
import { invalidateChatControllersForProviderChange } from './chat/controller-cache';

export type LlmProviderErrorCode =
  | 'llm_provider_base_url_credentials'
  | 'llm_provider_secrets_reentry_required';

/** Validation failure. `status` defaults to 400; some carry a 409 and a machine-readable code. */
export class LlmProviderValidationError extends Error {
  readonly status: number;
  readonly code?: LlmProviderErrorCode;
  constructor(message: string, options?: { status?: number; code?: LlmProviderErrorCode }) {
    super(message);
    this.name = 'LlmProviderValidationError';
    this.status = options?.status ?? 400;
    this.code = options?.code;
  }
}

/** JSON body + status for a LlmProviderValidationError (used by the provider API routes). */
export function llmProviderErrorBody(err: LlmProviderValidationError): {
  body: { error: string; code?: LlmProviderErrorCode };
  status: number;
} {
  return { body: { error: err.message, ...(err.code ? { code: err.code } : {}) }, status: err.status };
}

export interface LlmProviderPublic {
  id: string;
  name: string;
  type: LlmProviderType;
  baseURL: string;
  hasApiKey: boolean;
  /**
   * #106: write-only. Header *names* with empty values; real values never leave the server
   * (they often carry auth). Use `headerNames` for display.
   */
  headers: Record<string, string>;
  headerNames: string[];
  apiMode: 'chat' | 'responses';
  isDefault: boolean;
  defaultModelSettings: AgentModelSettings;
  defaultModel: string | null;
  stickiness: 'off' | 'agent' | 'chat';
  stickinessHeaderName: string;
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
  defaultModel?: string | null;
  stickiness?: string;
  stickinessHeaderName?: string;
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
  defaultModel?: string | null;
  stickiness?: string;
  stickinessHeaderName?: string;
}

/** #106: header names only, values blanked. */
export function redactHeaderValues(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(headers).map((name) => [name, '']));
}

/** Blank = empty or whitespace-only (a header value can't meaningfully be whitespace). */
function isBlankHeaderValue(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * Submitted headers must be a plain object mapping names to string values. Anything else
 * (null, an array, a string, non-string values) is a 400, not a 500.
 */
export function validateHeadersInput(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LlmProviderValidationError('Headers must be an object of header names to string values.');
  }
  for (const v of Object.values(value)) {
    if (typeof v !== 'string') {
      throw new LlmProviderValidationError('Header values must be strings.');
    }
  }
  return value as Record<string, string>;
}

/**
 * #106: headers are write-only, so the UI round-trips blank values for headers it did not
 * change. A blank (empty or whitespace-only) value for an existing header keeps the stored
 * value; headers left out are removed; non-blank values replace.
 * Own-property checks only: names like `constructor`, `toString` or `__proto__` are ordinary
 * header names, never inherited object members. Object.fromEntries keeps `__proto__` as an
 * own key.
 */
export function mergeWriteOnlyHeaders(
  existing: Record<string, string>,
  submitted: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(submitted).map(([name, value]) => [
      name,
      isBlankHeaderValue(value) && Object.hasOwn(existing, name) ? existing[name] : value,
    ]),
  );
}

function toPublic(row: LlmProvider): LlmProviderPublic {
  const record = toLlmProviderRecord(row);
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    // #121 S2: userinfo/query/fragment never leave the server (a `?api_key=` is a secret).
    // On update, submitting this redacted form back keeps the stored URL (see updateLlmProvider).
    baseURL: redactBaseURL(record.baseURL),
    hasApiKey: Boolean(record.apiKey),
    headers: redactHeaderValues(record.headers),
    headerNames: Object.keys(record.headers),
    apiMode: record.apiMode,
    isDefault: record.isDefault,
    defaultModelSettings: record.defaultModelSettings,
    defaultModel: record.defaultModel,
    stickiness: record.stickiness,
    stickinessHeaderName: record.stickinessHeaderName,
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
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new LlmProviderValidationError('Base URL must be a valid URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new LlmProviderValidationError('Base URL must use http or https.');
  }
  // #121 S2: fetch can never use user:pass@, and the URL is echoed back; refuse it (409).
  if (baseURLHasCredentials(trimmed)) {
    throw new LlmProviderValidationError(BASE_URL_CREDENTIALS_MESSAGE, {
      status: 409,
      code: 'llm_provider_base_url_credentials',
    });
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

function normalizeDefaultModel(model?: string | null): string | null {
  const trimmed = model?.trim();
  return trimmed ? trimmed : null;
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

/**
 * Seed a default provider from env when the registry is empty.
 * #121 S5: only when the env actually configures one (LLM_PROVIDER or a base-URL var for the
 * resolved kind, trimmed and non-blank) and the resolved base URL is non-blank and has no
 * user:pass@. Otherwise nothing is created, so a fresh install with no env gets the 409
 * "not configured" answer instead of a phantom localhost LM Studio default.
 */
export async function ensureDefaultLlmProviders(): Promise<void> {
  const existing = await listLlmProviderRows();
  if (existing.length > 0) return;

  const envConfig = resolveModelProviderConfigFromEnv();
  if (!envProviderConfigured(envConfig)) return;
  const baseURL = envConfig.baseURL.trim().replace(/\/$/, '');
  if (!baseURL || baseURLHasCredentials(baseURL)) return;

  const type = parseLlmProviderType(envConfig.provider) ?? 'lmstudio';
  const apiKey = envConfig.apiKey?.trim();

  await db.insert(llmProviders).values({
    name: defaultProviderSeedName(type),
    type,
    baseURL,
    apiKey: apiKey || null,
    headers: envConfig.headers,
    apiMode: envConfig.apiMode,
    isDefault: true,
  });
  invalidateChatControllersForProviderChange();
}

/**
 * When an update moves the provider to another host (or downgrades https → http), stored
 * secrets must not silently follow it: the API key and the value of every stored header that is
 * kept must be re-entered in the same request. Returns the names of what is missing.
 */
export function missingSecretsForHostChange(
  existing: { apiKey: string | null; headers: Record<string, string> },
  input: Pick<UpdateLlmProviderInput, 'apiKey' | 'clearApiKey' | 'headers'>,
): string[] {
  const missing: string[] = [];
  if (existing.apiKey && !input.clearApiKey && !(typeof input.apiKey === 'string' && input.apiKey.trim())) {
    missing.push('the API key');
  }
  const storedNames = Object.keys(existing.headers);
  if (storedNames.length > 0) {
    if (input.headers === undefined) {
      // Headers not submitted → all stored values would be carried over.
      missing.push(...storedNames.map((n) => `header "${n}"`));
    } else {
      for (const [name, value] of Object.entries(input.headers)) {
        if (Object.hasOwn(existing.headers, name) && isBlankHeaderValue(value)) {
          missing.push(`header "${name}"`);
        }
      }
    }
  }
  return missing;
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

/**
 * A header name that isn't already stored on the provider (new, or renamed in the UI) has no
 * stored value to fall back on, so it must be submitted with a non-blank value. Otherwise it
 * would be saved as ''. Blank values for already-stored names are left to the caller's merge
 * rules. Used on create (nothing stored) and update.
 */
export function assertNewHeaderValues(
  existing: Record<string, string>,
  submitted: Record<string, string>,
): void {
  const missing = Object.entries(submitted)
    .filter(([name, value]) => !Object.hasOwn(existing, name) && isBlankHeaderValue(value))
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new LlmProviderValidationError(
      `Header ${missing.map((n) => `"${n}"`).join(', ')} needs a value (new or renamed headers can't be blank).`,
    );
  }
}

export async function createLlmProvider(input: CreateLlmProviderInput): Promise<LlmProviderPublic> {
  await ensureDefaultLlmProviders();

  const name = validateName(input.name);
  const type = parseProviderType(input.type);
  const baseURL = validateBaseURL(input.baseURL || defaultBaseURLForProviderType(type));
  const apiMode = parseModelApiMode(input.apiMode) ?? 'chat';
  const headers = input.headers == null ? {} : validateHeadersInput(input.headers);
  assertNewHeaderValues({}, headers);
  const isDefault = input.isDefault ?? false;
  const defaultModelSettings = validateDefaultModelSettings(input.defaultModelSettings);
  const defaultModel = normalizeDefaultModel(input.defaultModel);
  const stickiness = parseStickinessType(input.stickiness) ?? 'off';
  const stickinessHeaderName = input.stickinessHeaderName?.trim() || 'x-litellm-session-id';

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
      defaultModel,
      stickiness,
      stickinessHeaderName,
    })
    .returning();

  invalidateChatControllersForProviderChange();
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
  if (input.baseURL !== undefined) {
    // The UI gets the redacted URL (toPublic); getting exactly that back means "unchanged".
    const submitted = input.baseURL.trim();
    // (Not when the stored URL has user:pass@: then the stripped form is saved, cleaning it up.)
    const keepStored =
      submitted !== '' &&
      submitted !== existing.baseURL &&
      submitted === redactBaseURL(existing.baseURL) &&
      !baseURLHasCredentials(existing.baseURL);
    if (!keepStored) updates.baseURL = validateBaseURL(input.baseURL);
  }
  if (input.headers !== undefined) {
    const storedHeaders = parseHeaders(existing.headers);
    // New/renamed names need a value; blank values for stored names keep the stored value.
    const submitted = validateHeadersInput(input.headers); // null → 400
    assertNewHeaderValues(storedHeaders, submitted);
    updates.headers = mergeWriteOnlyHeaders(storedHeaders, submitted);
  }
  // Host change: stored key/header values are not carried to the new host (checked after the
  // headers are validated, before any write).
  if (updates.baseURL !== undefined && !sameCredentialBoundary(existing.baseURL, updates.baseURL)) {
    const missing = missingSecretsForHostChange(
      { apiKey: existing.apiKey, headers: parseHeaders(existing.headers) },
      input,
    );
    if (missing.length > 0) {
      throw new LlmProviderValidationError(
        `The base URL now points at a different host (${redactBaseURL(existing.baseURL)} → ` +
          `${redactBaseURL(updates.baseURL)}), so stored secrets are not carried over. ` +
          `Re-enter ${missing.join(', ')} (or clear ${missing.length === 1 ? 'it' : 'them'}) in the same save.`,
        { status: 409, code: 'llm_provider_secrets_reentry_required' },
      );
    }
  }
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
  } else if (input.isDefault === false) {
    updates.isDefault = false;
  }

  if (input.defaultModelSettings !== undefined) {
    updates.defaultModelSettings = validateDefaultModelSettings(input.defaultModelSettings);
  }

  if (input.defaultModel !== undefined) {
    updates.defaultModel = normalizeDefaultModel(input.defaultModel);
  }

  if (input.stickiness !== undefined) {
    const stickiness = parseStickinessType(input.stickiness);
    if (!stickiness) {
      throw new LlmProviderValidationError('Stickiness must be off, agent, or chat.');
    }
    updates.stickiness = stickiness;
  }

  if (input.stickinessHeaderName !== undefined) {
    updates.stickinessHeaderName = input.stickinessHeaderName.trim() || 'x-litellm-session-id';
  }

  const [updated] = await db
    .update(llmProviders)
    .set(updates)
    .where(eq(llmProviders.id, id))
    .returning();

  if (!updated) throw new LlmProviderValidationError('Provider not found.');
  // The default may have moved or this provider's settings changed: rebuild chat controllers.
  invalidateChatControllersForProviderChange();

  const stillHasDefault = await getDefaultLlmProviderRow();
  if (!stillHasDefault) {
    await db
      .update(llmProviders)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(llmProviders.id, id));
    invalidateChatControllersForProviderChange();
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
  invalidateChatControllersForProviderChange();

  if (existing.isDefault) {
    const remaining = await listLlmProviderRows();
    if (remaining.length > 0) {
      await db
        .update(llmProviders)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(llmProviders.id, remaining[0].id));
      invalidateChatControllersForProviderChange();
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
