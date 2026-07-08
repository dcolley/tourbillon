import { z } from 'zod';

export const REASONING_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** LLM generation parameters — stored on providers (defaults) and agents (overrides). */
export interface AgentModelSettings {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  topK?: number;
  seed?: number;
  /** Per-agent reasoning depth override (agent-only; not inherited from provider defaults). */
  reasoningLevel?: ReasoningLevel;
}

export const AgentModelSettingsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  topK: z.number().int().positive().optional(),
  seed: z.number().int().optional(),
  reasoningLevel: z.enum(REASONING_LEVELS).optional(),
});

const NUMERIC_MODEL_SETTING_KEYS = [
  'temperature',
  'topP',
  'maxOutputTokens',
  'frequencyPenalty',
  'presencePenalty',
  'topK',
  'seed',
] as const satisfies ReadonlyArray<keyof AgentModelSettings>;

export type NumericModelSettingKey = (typeof NUMERIC_MODEL_SETTING_KEYS)[number];

export type AgentModelSettingsPatch = Partial<
  Record<NumericModelSettingKey, number | null>
> & {
  reasoningLevel?: ReasoningLevel | null;
};

function stripUndefined(settings: AgentModelSettings): AgentModelSettings {
  const result: AgentModelSettings = {};
  for (const key of NUMERIC_MODEL_SETTING_KEYS) {
    const value = settings[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  if (settings.reasoningLevel !== undefined) {
    result.reasoningLevel = settings.reasoningLevel;
  }
  return result;
}

/** Numeric generation params only (excludes reasoningLevel). */
export function stripNumericModelSettings(
  settings: AgentModelSettings | null | undefined,
): Omit<AgentModelSettings, 'reasoningLevel'> {
  const result: Omit<AgentModelSettings, 'reasoningLevel'> = {};
  if (!settings) return result;
  for (const key of NUMERIC_MODEL_SETTING_KEYS) {
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

/** Return Mastra-compatible numeric modelSettings, or undefined when none are configured. */
export function toMastraModelSettings(
  settings: AgentModelSettings | null | undefined,
): Omit<AgentModelSettings, 'reasoningLevel'> | undefined {
  const stripped = stripNumericModelSettings(settings);
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

/** Parse reasoning level select — empty string clears the field. */
export function parseReasoningLevelFormValue(
  raw: FormDataEntryValue | null | undefined,
): ReasoningLevel | undefined | null {
  if (raw == null) return undefined;
  const text = String(raw).trim();
  if (!text) return null;
  const parsed = z.enum(REASONING_LEVELS).safeParse(text);
  if (!parsed.success) {
    throw new Error(`Invalid reasoning level: ${text}`);
  }
  return parsed.data;
}

/** Build model settings patch from form data (null = clear stored override). */
export function modelSettingsFromFormData(
  formData: FormData,
  prefix = '',
): AgentModelSettingsPatch {
  const patch: AgentModelSettingsPatch = {};
  for (const key of NUMERIC_MODEL_SETTING_KEYS) {
    const fieldName = `${prefix}${key}`;
    if (!formData.has(fieldName)) continue;
    patch[key] = parseModelSettingFormValue(formData.get(fieldName));
  }

  const reasoningField = `${prefix}reasoningLevel`;
  if (formData.has(reasoningField)) {
    patch.reasoningLevel = parseReasoningLevelFormValue(formData.get(reasoningField));
  }

  return patch;
}

/** Apply a form patch onto existing settings, removing keys set to null. */
export function applyModelSettingsPatch(
  current: AgentModelSettings | undefined,
  patch: AgentModelSettingsPatch,
): AgentModelSettings {
  const next: AgentModelSettings = { ...(current ?? {}) };
  for (const key of NUMERIC_MODEL_SETTING_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null || value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }

  if ('reasoningLevel' in patch) {
    const value = patch.reasoningLevel;
    if (value === null || value === undefined) {
      delete next.reasoningLevel;
    } else {
      next.reasoningLevel = value;
    }
  }

  return stripUndefined(next);
}
