/**
 * CHAT-5: model and effort choice per assistant thread (pure helpers, safe in client bundles).
 *
 * The choice is stored on the thread (Mastra thread metadata, key `assistantModel`), so it applies
 * to that thread only. No choice: the agent's configured model. The picker offers only providers
 * switched on for the company (PRV-1); the server re-checks enablement when the choice is saved and
 * on every run, and refuses a provider that is off.
 */
import { REASONING_LEVELS, type ReasoningLevel } from '@tourbillon/shared/model-settings';
import {
  inferReasoningCapabilities,
  type ModelReasoningCapabilities,
} from '@tourbillon/shared/reasoning-capabilities';

/** Thread metadata key holding the thread's model choice. */
export const ASSISTANT_THREAD_MODEL_KEY = 'assistantModel';

export const THREAD_MODEL_ID_MAX = 200;
export const THREAD_PROVIDER_ID_MAX = 100;

export interface ThreadModelChoice {
  providerId: string;
  modelId: string;
  /** Unset: the model's (or agent's) default effort. */
  reasoningLevel?: ReasoningLevel;
}

/** Provider entry offered by the picker (no URLs, keys or headers). */
export interface PickerProvider {
  id: string;
  name: string;
  type: string;
}

/** What GET/PUT /api/assistant/agents/[agentId]/threads/[threadId]/model return. */
export interface ThreadModelState {
  /** The thread's stored choice, or null (agent default). */
  choice: ThreadModelChoice | null;
  /** False when the stored choice's provider is no longer on for the company (runs are refused). */
  choiceAvailable: boolean;
  /** The agent's configured model, used when the thread has no choice. */
  agentDefault: { providerId: string | null; providerName: string | null; modelId: string | null };
  /** Providers switched on for the company. */
  providers: PickerProvider[];
}

// Visible ASCII only: model ids look like `org/model:tag@rev`; ids are UUIDs or slugs.
const MODEL_ID_RE = /^[\x21-\x7e]+$/;
const PROVIDER_ID_RE = /^[A-Za-z0-9_.:-]+$/;

export function isThreadModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= THREAD_MODEL_ID_MAX && MODEL_ID_RE.test(value);
}

export function isThreadProviderId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= THREAD_PROVIDER_ID_MAX && PROVIDER_ID_RE.test(value)
  );
}

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === 'string' && (REASONING_LEVELS as readonly string[]).includes(value);
}

/** The stored choice, or null when the metadata value is missing or not a valid choice. */
export function parseThreadModelChoice(raw: unknown): ThreadModelChoice | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isThreadProviderId(r.providerId) || !isThreadModelId(r.modelId)) return null;
  if (r.reasoningLevel !== undefined && r.reasoningLevel !== null && !isReasoningLevel(r.reasoningLevel)) return null;
  return {
    providerId: r.providerId,
    modelId: r.modelId,
    ...(isReasoningLevel(r.reasoningLevel) ? { reasoningLevel: r.reasoningLevel } : {}),
  };
}

/** The thread's choice from its metadata bag. */
export function threadModelChoiceFromMetadata(metadata: unknown): ThreadModelChoice | null {
  if (!metadata || typeof metadata !== 'object') return null;
  return parseThreadModelChoice((metadata as Record<string, unknown>)[ASSISTANT_THREAD_MODEL_KEY]);
}

/**
 * Providers the picker offers: only those on for the company. Unlike the settings pickers
 * (providersForCompanyPicker), a provider that is off is never listed, even when a thread still
 * points at it; the picker shows that choice as unavailable instead.
 */
export function pickerProvidersForCompany<T extends { id: string; name: string; type: string; enabledForCompany: boolean }>(
  providers: T[],
): PickerProvider[] {
  return providers.filter((p) => p.enabledForCompany).map((p) => ({ id: p.id, name: p.name, type: p.type }));
}

/**
 * Effort levels to offer for a model: the provider's own capabilities when it reports them
 * (LM Studio), else the shared heuristic. Empty: effort is not supported, so it is not shown.
 */
export function effortLevelsForModel(
  modelId: string | null | undefined,
  capabilities?: ModelReasoningCapabilities | null,
  providerType?: string,
): ReasoningLevel[] {
  if (capabilities?.supported && capabilities.allowedLevels.length > 0) return capabilities.allowedLevels;
  if (!modelId) return [];
  const inferred = inferReasoningCapabilities(modelId, providerType as never);
  return inferred.supported ? inferred.allowedLevels : [];
}

/** Keeps `level` only when the model supports it. */
export function effortForModel(level: ReasoningLevel | undefined | null, allowed: readonly ReasoningLevel[]): ReasoningLevel | undefined {
  return level && allowed.includes(level) ? level : undefined;
}
