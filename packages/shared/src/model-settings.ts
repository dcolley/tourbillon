import { z } from 'zod';

/** LLM generation parameters — stored on providers (defaults) and agents (overrides). */
export interface AgentModelSettings {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  topK?: number;
  seed?: number;
}

export const AgentModelSettingsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  topK: z.number().int().positive().optional(),
  seed: z.number().int().optional(),
});

const MODEL_SETTING_KEYS = [
  'temperature',
  'topP',
  'maxOutputTokens',
  'frequencyPenalty',
  'presencePenalty',
  'topK',
  'seed',
] as const satisfies ReadonlyArray<keyof AgentModelSettings>;

function stripUndefined(settings: AgentModelSettings): AgentModelSettings {
  const result: AgentModelSettings = {};
  for (const key of MODEL_SETTING_KEYS) {
    const value = settings[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/** Validate and normalize partial model settings from API/form payloads. */
export function parseAgentModelSettings(input: unknown): AgentModelSettings {
  if (input == null || typeof input !== 'object') {
    return {};
  }
  const parsed = AgentModelSettingsSchema.partial().safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  return stripUndefined(parsed.data);
}

/** Merge provider defaults with per-agent overrides (agent wins per field). */
export function resolveModelSettings(
  providerDefaults?: AgentModelSettings | null,
  agentOverrides?: AgentModelSettings | null,
): AgentModelSettings {
  return stripUndefined({
    ...(providerDefaults ?? {}),
    ...(agentOverrides ?? {}),
  });
}

/** Return Mastra-compatible modelSettings, or undefined when no settings are configured. */
export function toMastraModelSettings(
  settings: AgentModelSettings | null | undefined,
): AgentModelSettings | undefined {
  const stripped = stripUndefined(settings ?? {});
  return Object.keys(stripped).length > 0 ? stripped : undefined;
}

/** Parse a single numeric form field — empty string clears the field. */
export function parseModelSettingFormValue(
  raw: FormDataEntryValue | null | undefined,
): number | undefined | null {
  if (raw == null) return undefined;
  const text = String(raw).trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid number: ${text}`);
  }
  return value;
}

/** Build model settings patch from form data (null = clear stored override). */
export function modelSettingsFromFormData(
  formData: FormData,
  prefix = '',
): Partial<Record<keyof AgentModelSettings, number | null>> {
  const patch: Partial<Record<keyof AgentModelSettings, number | null>> = {};
  for (const key of MODEL_SETTING_KEYS) {
    const fieldName = `${prefix}${key}`;
    if (!formData.has(fieldName)) continue;
    patch[key] = parseModelSettingFormValue(formData.get(fieldName));
  }
  return patch;
}

/** Apply a form patch onto existing settings, removing keys set to null. */
export function applyModelSettingsPatch(
  current: AgentModelSettings | undefined,
  patch: Partial<Record<keyof AgentModelSettings, number | null>>,
): AgentModelSettings {
  const next: AgentModelSettings = { ...(current ?? {}) };
  for (const key of MODEL_SETTING_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null || value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return stripUndefined(next);
}
