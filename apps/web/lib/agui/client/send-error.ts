/**
 * TB-364 (A17/A18/A37, normative name): classify a failed send / run error into a category,
 * decide automatic-retry eligibility (PM Q3: ONLY 429, 5xx and network/timeouts auto-retry;
 * unknown = permanent, never auto-retried), derive the friendly copy, and produce the
 * redacted technical text. Pure — no I/O, no timers.
 *
 * The server classifies too (A19): a RUN_ERROR may carry machine fields (`category`,
 * `retryable`, `retryAfterMs`); when present they win, and this module still derives the
 * friendly copy and re-applies the redactor defensively (A26: a stored legacy raw string still
 * renders redacted).
 */
import { redactErrorText, TECHNICAL_MAX_CHARS } from '../redact-error';

export type SendErrorCategory =
  | 'network'
  | 'timeout'
  | 'rate_limited'
  | 'server_error'
  | 'auth'
  | 'context_length'
  | 'bad_request'
  | 'not_found'
  | 'policy'
  | 'provider_disabled'
  | 'conflict'
  | 'unknown';

/** What the caller saw, in the shapes the client really sees. */
export interface SendErrorInput {
  kind: 'run' | 'network' | 'http' | 'conflict' | 'timeout' | 'disconnected';
  message?: string;
  status?: number;
  /** Seconds, as the client parsed a 429 `Retry-After` (numeric form). */
  retryAfterSeconds?: number;
  /** Raw `Retry-After` header value: delta-seconds or HTTP-date. */
  retryAfter?: string;
  /** Server-classified fields (A19): present on a classified RUN_ERROR. */
  category?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  /** A17 code field from RUN_ERROR when the server attached one. */
  code?: string;
}

export interface ClassifiedSendError {
  category: SendErrorCategory;
  /** Eligible for AUTOMATIC retry (PM Q3 table). Manual Retry is offered regardless. */
  retryable: boolean;
  /** From `Retry-After` when present. */
  retryAfterMs?: number;
  friendly: { title: string; hint: string };
  /** Redacted, bounded raw text (A25/A26): never shown by default, ≤ TECHNICAL_MAX_CHARS. */
  technical: string;
}

/** PM Q3 (ruled): only these classes auto-retry. */
const AUTO_RETRYABLE: ReadonlySet<SendErrorCategory> = new Set<SendErrorCategory>([
  'network',
  'timeout',
  'rate_limited',
  'server_error',
]);

const LITELLM_PATTERNS: Array<{ re: RegExp; category: SendErrorCategory }> = [
  { re: /litellm\.RateLimitError|\b429\b.{0,40}(rate.?limit|too many requests)/i, category: 'rate_limited' },
  { re: /litellm\.Timeout|\btimeout(expired)?\b|timed out|Connection timed out/i, category: 'timeout' },
  {
    re: /litellm\.InternalServerError|litellm\.ServiceUnavailableError|InternalServerError|ServiceUnavailable|no fallback model group|Bad Gateway|Gateway Timeout/i,
    category: 'server_error',
  },
  { re: /litellm\.APIConnectionError|Connection error|fetch failed|network|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i, category: 'network' },
  { re: /litellm\.ContextWindowExceededError|maximum context length|context length/i, category: 'context_length' },
  { re: /litellm\.ContentPolicyViolationError|content policy|policy violation/i, category: 'policy' },
  { re: /litellm\.AuthenticationError|invalid api key|invalid API key/i, category: 'auth' },
  { re: /litellm\.NotFoundError|model not found|model_not_found/i, category: 'not_found' },
  { re: /litellm\.BadRequestError/i, category: 'bad_request' },
  { re: /provider_disabled_for_company/i, category: 'provider_disabled' },
];

function fromStatus(status: number): SendErrorCategory {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 413 || status === 422) return 'bad_request';
  return 'unknown';
}

function fromText(text: string): SendErrorCategory | null {
  for (const { re, category } of LITELLM_PATTERNS) if (re.test(text)) return category;
  return null;
}

function parseRetryAfterMs(input: SendErrorInput): number | undefined {
  if (typeof input.retryAfterMs === 'number' && Number.isFinite(input.retryAfterMs) && input.retryAfterMs >= 0) {
    return Math.floor(input.retryAfterMs);
  }
  if (typeof input.retryAfterSeconds === 'number' && Number.isFinite(input.retryAfterSeconds) && input.retryAfterSeconds >= 0) {
    return Math.floor(input.retryAfterSeconds * 1000);
  }
  const raw = input.retryAfter?.trim();
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.floor(secs * 1000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

const FRIENDLY: Record<SendErrorCategory, { title: string; hint: string }> = {
  network: { title: "Couldn't reach the assistant", hint: 'Your connection dropped. Retry when you are back online.' },
  timeout: { title: 'The model took too long to answer', hint: 'This usually passes — Retry to ask again.' },
  rate_limited: { title: 'The model is busy right now', hint: 'Too many requests at the moment. Retry in a moment.' },
  server_error: { title: 'The model service hit an error', hint: 'The provider failed this request. Retry to try again.' },
  auth: { title: 'Your session expired', hint: 'Sign in again, then Retry to send the message.' },
  context_length: { title: 'The conversation is too long for this model', hint: 'Use Retry on another model with a larger context.' },
  bad_request: { title: 'The message was rejected', hint: 'The assistant could not accept this message as sent. Edit or Retry.' },
  not_found: { title: 'The model is not available', hint: 'The chosen model could not be found. Try Retry on another model.' },
  policy: { title: 'The reply was blocked by content policy', hint: 'Rephrase the message and Retry.' },
  provider_disabled: { title: 'This provider is switched off for your company', hint: 'Pick another model with Retry on another model, or ask an admin to enable it.' },
  conflict: { title: 'Another reply is in progress', hint: 'Wait for the current reply, then Retry.' },
  unknown: { title: 'The message could not be sent', hint: 'Something went wrong. Retry to try again.' },
};

const VALID_CATEGORIES = new Set<string>(Object.keys(FRIENDLY));

/**
 * Classify one failure. Never throws; unknown input degrades to `unknown` (never auto-retried,
 * manual Retry still offered — A18 conservative default).
 */
export function classifySendError(input: SendErrorInput): ClassifiedSendError {
  const raw = typeof input.message === 'string' ? input.message : '';
  let category: SendErrorCategory | undefined;
  // Server-classified fields win when present (A19), as long as the name is one we know.
  if (typeof input.category === 'string' && VALID_CATEGORIES.has(input.category)) {
    category = input.category as SendErrorCategory;
  }
  if (!category) {
    if (input.kind === 'timeout') {
      category = 'timeout';
    } else if (input.kind === 'network' || input.kind === 'disconnected') {
      category = fromText(raw) ?? (/fetch failed|aborted|abort error|network|ECONNRESET|socket hang up/i.test(raw) ? 'network' : 'network');
    } else if ((input.kind === 'http' || input.kind === 'conflict') && typeof input.status === 'number') {
      // Status decides first (A17/A18 tables are status-driven for HTTP); text can refine
      // provider classes that arrive with a generic status (LiteLLM tunnels its own names).
      const byText = fromText(raw);
      const byStatus = fromStatus(input.status);
      category =
        byStatus === 'server_error' || byStatus === 'rate_limited'
          ? byStatus
          : (byText ?? byStatus);
    } else {
      category = fromText(raw) ?? 'unknown';
    }
  }
  // Error names the fetch stack really raises for a request timeout (A17 last row).
  if (category === 'network' && /^AbortError$|^TimeoutError$/i.test(raw) === false && /abort(ed)?|timeout/i.test(raw) && input.kind === 'timeout') {
    category = 'timeout';
  }
  const retryAfterMs = parseRetryAfterMs(input);
  // Server-provided retryable wins for the KNOWN category; unknown never auto-retries (A18).
  const retryable =
    category === 'unknown'
      ? false
      : typeof input.retryable === 'boolean'
        ? input.retryable && AUTO_RETRYABLE.has(category)
        : AUTO_RETRYABLE.has(category);
  const friendly = FRIENDLY[category] ?? FRIENDLY.unknown;
  return {
    category,
    retryable,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    // Fresh copies so callers cannot mutate the shared table, and the friendly text is fixed
    // copy only — never derived from the raw provider text (A24).
    friendly: { title: friendly.title, hint: friendly.hint },
    technical: redactErrorText(raw).slice(0, TECHNICAL_MAX_CHARS),
  };
}

const SEND_KINDS: ReadonlySet<string> = new Set([
  'run',
  'network',
  'http',
  'conflict',
  'timeout',
  'disconnected',
]);

/**
 * TB-364: classify what the client's `AgentChatError` produced. Kinds outside the classifier's
 * input vocabulary (`rejected`, `cancelled`, `detached`) classify as `http` without a status,
 * which lands on `unknown` — permanent for auto-retry, manual Retry still offered (A18).
 */
export function classifyAgentError(error: {
  kind: string;
  message?: string;
  status?: number;
  category?: string;
  retryable?: boolean;
  retryAfterMs?: number;
}): ClassifiedSendError {
  return classifySendError({
    ...error,
    kind: (SEND_KINDS.has(error.kind) ? error.kind : 'http') as SendErrorInput['kind'],
  });
}
