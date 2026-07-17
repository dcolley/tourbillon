'use client';

import {
  REASONING_LEVELS,
  type AgentModelSettings,
  type NumericModelSettingKey,
  type ReasoningLevel,
} from '@tourbillon/shared/model-settings';

const REASONING_LEVEL_LABELS: Record<ReasoningLevel, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
};

export const MODEL_SETTING_FIELDS = [
  {
    key: 'temperature' as const,
    label: 'Temperature',
    min: 0,
    max: 2,
    step: 0.1,
    hint: 'Higher = more creative. Usually set temperature or Top P, not both.',
  },
  {
    key: 'topP' as const,
    label: 'Top P',
    min: 0,
    max: 1,
    step: 0.05,
    hint: 'Nucleus sampling threshold.',
  },
  {
    key: 'maxOutputTokens' as const,
    label: 'Max output tokens',
    min: 1,
    max: 1_000_000,
    step: 1,
    hint: 'Cap response length per generation step.',
  },
  {
    key: 'frequencyPenalty' as const,
    label: 'Frequency penalty',
    min: -2,
    max: 2,
    step: 0.1,
    hint: 'Reduce repeated phrasing.',
  },
  {
    key: 'presencePenalty' as const,
    label: 'Presence penalty',
    min: -2,
    max: 2,
    step: 0.1,
    hint: 'Encourage new topics.',
  },
  {
    key: 'topK' as const,
    label: 'Top K',
    min: 1,
    max: 1000,
    step: 1,
    hint: 'Advanced — limit token candidates per step.',
    advanced: true,
  },
  {
    key: 'seed' as const,
    label: 'Seed',
    min: 0,
    max: 2_147_483_647,
    step: 1,
    hint: 'Advanced — reproducibility where supported.',
    advanced: true,
  },
] satisfies Array<{
  key: NumericModelSettingKey;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
  advanced?: boolean;
}>;

export type ModelSettingsFormValues = Record<NumericModelSettingKey, string> & {
  reasoningLevel: string;
};

export function emptyModelSettingsFormValues(): ModelSettingsFormValues {
  return {
    temperature: '',
    topP: '',
    maxOutputTokens: '',
    frequencyPenalty: '',
    presencePenalty: '',
    topK: '',
    seed: '',
    reasoningLevel: '',
  };
}

export function modelSettingsToFormValues(
  settings?: AgentModelSettings | null,
): ModelSettingsFormValues {
  const values = emptyModelSettingsFormValues();
  if (!settings) return values;
  for (const field of MODEL_SETTING_FIELDS) {
    const value = settings[field.key];
    if (value !== undefined) {
      values[field.key] = String(value);
    }
  }
  if (settings.reasoningLevel) {
    values.reasoningLevel = settings.reasoningLevel;
  }
  return values;
}

export function formValuesToModelSettings(values: ModelSettingsFormValues): AgentModelSettings {
  const settings: AgentModelSettings = {};
  for (const field of MODEL_SETTING_FIELDS) {
    const raw = values[field.key].trim();
    if (!raw) continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${field.label} must be a number.`);
    }
    settings[field.key] = parsed;
  }
  const reasoningRaw = values.reasoningLevel.trim();
  if (reasoningRaw) {
    settings.reasoningLevel = reasoningRaw as ReasoningLevel;
  }
  return settings;
}

interface ModelSettingsFieldsProps {
  values: ModelSettingsFormValues;
  onChange: (values: ModelSettingsFormValues) => void;
  /** Provider defaults shown as placeholders when agent field is blank. */
  providerDefaults?: AgentModelSettings;
  showAdvanced?: boolean;
}

export function ModelSettingsFields({
  values,
  onChange,
  providerDefaults,
  showAdvanced = true,
}: ModelSettingsFieldsProps) {
  const fields = MODEL_SETTING_FIELDS.filter((field) => showAdvanced || !field.advanced);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map((field) => {
        const providerValue = providerDefaults?.[field.key];
        const placeholder =
          providerValue !== undefined
            ? `${providerValue} (from provider)`
            : 'Provider default';

        return (
          <div key={field.key} className="space-y-1.5">
            <label htmlFor={`model-${field.key}`} className="text-sm font-medium">
              {field.label}
            </label>
            <input
              id={`model-${field.key}`}
              name={field.key}
              type="number"
              min={field.min}
              max={field.max}
              step={field.step}
              value={values[field.key]}
              onChange={(e) =>
                onChange({
                  ...values,
                  [field.key]: e.target.value,
                })
              }
              placeholder={providerDefaults ? placeholder : 'Leave blank for provider default'}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="text-xs text-muted-foreground">{field.hint}</p>
          </div>
        );
      })}
    </div>
  );
}

interface ReasoningLevelFieldProps {
  value: string;
  allowedLevels?: ReasoningLevel[];
  onChange: (value: string) => void;
}

export function ReasoningLevelField({
  value,
  allowedLevels = [...REASONING_LEVELS],
  onChange,
}: ReasoningLevelFieldProps) {
  return (
    <div className="space-y-1.5 sm:col-span-2">
      <label htmlFor="model-reasoningLevel" className="text-sm font-medium">
        Reasoning level
      </label>
      <select
        id="model-reasoningLevel"
        name="reasoningLevel"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm sm:max-w-xs"
      >
        <option value="">Endpoint default</option>
        {allowedLevels.map((level) => (
          <option key={level} value={level}>
            {REASONING_LEVEL_LABELS[level]}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">
        Controls internal reasoning depth when the selected model and provider support it.
      </p>
    </div>
  );
}
