/**
 * Errors from web → scheduler calls (wake, schedule sync, force-kill).
 *
 * Callers show users and MCP clients a fixed message only. The underlying detail (fetch error
 * text, scheduler response body) is logged server-side after Authorization values are redacted.
 * Never put the detail into a redirect URL, a toast, or a tool result.
 */

export type SchedulerErrorCode =
  /** fetch() itself threw (network error, invalid request header, …). */
  | 'request_failed'
  /** The scheduler answered with a non-success status. */
  | 'bad_status'
  /** The scheduler reported that a wake is already in flight for the agent. */
  | 'wake_in_flight';

export const SCHEDULER_REQUEST_ERROR_MESSAGE = 'Scheduler request failed.';
export const WAKE_IN_FLIGHT_MESSAGE = 'a wake may already be in flight';

/** Thrown by lib/wake-client. The message is always a fixed string, never upstream text. */
export class SchedulerRequestError extends Error {
  readonly code: SchedulerErrorCode;
  readonly status?: number;

  constructor(code: SchedulerErrorCode, status?: number) {
    super(code === 'wake_in_flight' ? WAKE_IN_FLIGHT_MESSAGE : SCHEDULER_REQUEST_ERROR_MESSAGE);
    this.name = 'SchedulerRequestError';
    this.code = code;
    this.status = status;
  }
}

const REDACTED = '[redacted]';

/**
 * Remove Authorization header values from free text before it is logged: the configured
 * scheduler key (raw and JSON-escaped), quoted and unquoted Bearer/Basic credentials, and
 * `Authorization: …` / `"authorization": "…"` pairs.
 */
export function redactSchedulerErrorDetail(text: string): string {
  let out = text;
  const key = process.env.SCHEDULER_API_KEY;
  if (key) {
    const variants = new Set([key, key.trim(), JSON.stringify(key).slice(1, -1)]);
    for (const v of variants) {
      if (v.length >= 4) out = out.split(v).join(REDACTED);
    }
  }
  out = out.replace(/(["'])(Bearer|Basic)\s[^"']*\1/gi, `$1$2 ${REDACTED}$1`);
  out = out.replace(/\b(Bearer|Basic)\s+(?!\[redacted\])[^\s"',;}]+/gi, `$1 ${REDACTED}`);
  out = out.replace(
    /(authorization["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;}]*)/gi,
    `$1${REDACTED}`,
  );
  return out;
}

function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 4; depth++) {
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' <- ');
}

/** Log scheduler call failure detail server-side with Authorization values redacted. */
export function logSchedulerError(context: string, err: unknown): void {
  console.error(`[scheduler] ${context} failed: ${redactSchedulerErrorDetail(describeError(err))}`);
}

/** Log a non-success scheduler response (status + body) with Authorization values redacted. */
export function logSchedulerResponseError(context: string, status: number, body: string): void {
  console.error(
    `[scheduler] ${context} failed (${status}): ${redactSchedulerErrorDetail(body.slice(0, 2000))}`,
  );
}

/** Fixed client codes for a wake the scheduler skipped (HTTP 409, status "skipped"). */
export type WakeSkipCode =
  | 'agent_paused'
  | 'agent_archived'
  | 'agent_pending_approval'
  | 'company_paused'
  | 'company_archived'
  | 'over_budget'
  | 'wake_in_flight'
  | 'unknown';

/** Fixed client text per skip code. Never scheduler response text. */
export const WAKE_SKIP_MESSAGES: Readonly<Record<WakeSkipCode, string>> = {
  agent_paused: 'Agent is paused.',
  agent_archived: 'Agent is archived.',
  agent_pending_approval: 'Agent is pending approval.',
  company_paused: 'Company is paused.',
  company_archived: 'Company is archived.',
  over_budget: 'Agent is over its token budget.',
  wake_in_flight: 'A wake is already in flight for this agent.',
  unknown: 'Wake skipped.',
};

/**
 * Exact scheduler skip texts (packages/scheduler wake-runner) → client code. Matched as whole
 * strings only; anything else, including unknown agent/company statuses, is `unknown`.
 */
const KNOWN_SCHEDULER_SKIP_TEXTS: ReadonlyMap<string, WakeSkipCode> = new Map([
  ['agent status paused', 'agent_paused'],
  ['agent status archived', 'agent_archived'],
  ['agent status pending_approval', 'agent_pending_approval'],
  ['company status paused', 'company_paused'],
  ['company status archived', 'company_archived'],
  ['over token budget', 'over_budget'],
  ['coalesced behind in-flight wake', 'wake_in_flight'],
]);

/** Map a scheduler skip reason to a fixed client code + message. */
export function wakeSkipReason(raw: unknown): { code: WakeSkipCode; message: string } {
  const code =
    (typeof raw === 'string' && KNOWN_SCHEDULER_SKIP_TEXTS.get(raw.trim())) || 'unknown';
  return { code, message: WAKE_SKIP_MESSAGES[code] };
}

/** Client text for a skipped wake, derived from the fixed code only (never free text). */
export function wakeSkipMessage(code: WakeSkipCode | undefined): string {
  return (code && Object.hasOwn(WAKE_SKIP_MESSAGES, code) && WAKE_SKIP_MESSAGES[code]) || WAKE_SKIP_MESSAGES.unknown;
}
