import type { LlmProviderType } from './model-provider';
import type { ReasoningLevel } from './model-settings';

export interface ModelReasoningCapabilities {
  supported: boolean;
  allowedLevels: ReasoningLevel[];
}

const FULL_EFFORT_LEVELS: ReasoningLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const STANDARD_EFFORT_LEVELS: ReasoningLevel[] = ['none', 'low', 'medium', 'high'];
const BINARY_LEVELS: ReasoningLevel[] = ['none', 'medium'];

/** Map LM Studio native reasoning option strings to portable levels. */
export function mapNativeReasoningOption(option: string): ReasoningLevel | null {
  const normalized = option.trim().toLowerCase();
  switch (normalized) {
    case 'off':
    case 'none':
      return 'none';
    case 'on':
      return 'medium';
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return normalized as ReasoningLevel;
    default:
      return null;
  }
}

/** Parse LM Studio native capabilities.reasoning into allowed levels. */
export function reasoningCapabilitiesFromNative(
  allowedOptions: string[] | undefined,
): ModelReasoningCapabilities | null {
  if (!allowedOptions?.length) return null;

  const mapped = allowedOptions
    .map(mapNativeReasoningOption)
    .filter((level): level is ReasoningLevel => level != null);

  if (mapped.length === 0) return null;

  const unique = [...new Set(mapped)];
  return { supported: true, allowedLevels: unique };
}

const REASONING_MODEL_PATTERNS: Array<{ pattern: RegExp; levels: ReasoningLevel[] }> = [
  { pattern: /\bgpt-5\.1-codex-max\b/i, levels: FULL_EFFORT_LEVELS },
  { pattern: /\bgpt-5(?:\.\d+)?\b/i, levels: FULL_EFFORT_LEVELS },
  { pattern: /\bgpt-oss\b/i, levels: STANDARD_EFFORT_LEVELS },
  { pattern: /\bo[134](?:-mini|-pro|-preview)?\b/i, levels: STANDARD_EFFORT_LEVELS },
  { pattern: /\bdeepseek-r1\b/i, levels: BINARY_LEVELS },
  { pattern: /\bqwq\b/i, levels: STANDARD_EFFORT_LEVELS },
  { pattern: /\bqwen3(?:\.\d+)?\b/i, levels: STANDARD_EFFORT_LEVELS },
  { pattern: /\bnemotron\b/i, levels: STANDARD_EFFORT_LEVELS },
  { pattern: /\bgemma-4\b/i, levels: BINARY_LEVELS },
];

/** Heuristic reasoning support from model id and provider type. */
export function inferReasoningCapabilities(
  modelId: string,
  _providerType?: LlmProviderType,
): ModelReasoningCapabilities {
  const id = modelId.trim();
  if (!id) {
    return { supported: false, allowedLevels: [] };
  }

  for (const { pattern, levels } of REASONING_MODEL_PATTERNS) {
    if (pattern.test(id)) {
      return { supported: true, allowedLevels: levels };
    }
  }

  return { supported: false, allowedLevels: [] };
}

export const REASONING_LEVEL_LABELS: Record<ReasoningLevel, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
};
