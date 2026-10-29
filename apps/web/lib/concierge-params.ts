/**
 * CONCIERGE-PARAMS S195-S3 (#195 ACCEPT): server-side validation for the optional model
 * params on the company concierge model (Settings page, `saveConciergeModel`). The form
 * inputs carry min/max attributes, but the server must not trust the browser: the old
 * action checked only the minimums, so a crafted POST could store absurd windows, and it
 * never related the two values (output >= context is unservable — the model could emit
 * more tokens than the window it is trimmed to fit).
 *
 * The bounds mirror the number inputs in components/concierge-model-settings-form.tsx
 * (params.maxContextTokens: min 8000 / max 1048576; params.maxOutputTokens:
 * min 1024 / max 131072). concierge-params.test.ts pins the numbers; move one and the
 * pin fails until both sides agree.
 */

export const CONCIERGE_PARAM_BOUNDS = {
  maxContextTokens: { min: 8_000, max: 1_048_576 },
  maxOutputTokens: { min: 1_024, max: 131_072 },
} as const;

export interface ConciergeModelParams {
  maxContextTokens?: number;
  maxOutputTokens?: number;
}

export type ConciergeParamsValidation =
  | { ok: true; params: ConciergeModelParams }
  | { ok: false; error: string };

/**
 * Validate raw form strings for `params.maxContextTokens` / `params.maxOutputTokens`.
 * Blank means "not set" (provider default / env limit). Each value must be a whole
 * number within its bounds; when both are set, output must be strictly below context.
 */
export function validateConciergeModelParams(raw: {
  maxContextTokens?: string | null;
  maxOutputTokens?: string | null;
}): ConciergeParamsValidation {
  const params: ConciergeModelParams = {};
  for (const key of ['maxContextTokens', 'maxOutputTokens'] as const) {
    const text = (raw[key] ?? '').trim();
    if (!text) continue;
    const value = Number(text);
    const { min, max } = CONCIERGE_PARAM_BOUNDS[key];
    if (!Number.isInteger(value) || value < min) {
      return { ok: false, error: `Enter ${key} as a whole number of at least ${min} tokens (or leave it blank).` };
    }
    if (value > max) {
      return { ok: false, error: `Enter ${key} as a whole number of at most ${max} tokens (or leave it blank).` };
    }
    params[key] = value;
  }
  // Output must fit inside the window: the limiter sizes its trim from the context
  // window and reserves the output, so output >= context leaves no room to run.
  if (
    params.maxContextTokens !== undefined &&
    params.maxOutputTokens !== undefined &&
    params.maxOutputTokens >= params.maxContextTokens
  ) {
    return {
      ok: false,
      error: 'Enter max output tokens below max context tokens (the model must be able to answer inside its own window).',
    };
  }
  return { ok: true, params };
}
