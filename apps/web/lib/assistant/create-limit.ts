/**
 * UI-2: per-company limit on new assistant threads (sliding window, in process).
 *
 * The check and the record happen in one synchronous step, so concurrent requests in this
 * process cannot all pass the check before any of them is counted. The web app runs as a
 * single process; a multi-process deploy would need a shared counter.
 */
export const ASSISTANT_THREAD_CREATE_LIMIT = 20;
export const ASSISTANT_THREAD_CREATE_WINDOW_MS = 60_000;

const windows = new Map<string, number[]>();

export type CreateSlot = { ok: true } | { ok: false; retryAfterSec: number };

/** Take one creation slot for the company, or report how long until one frees up. */
export function takeThreadCreateSlot(companyId: string, now = Date.now()): CreateSlot {
  const since = now - ASSISTANT_THREAD_CREATE_WINDOW_MS;
  const recent = (windows.get(companyId) ?? []).filter((t) => t > since);
  if (recent.length >= ASSISTANT_THREAD_CREATE_LIMIT) {
    windows.set(companyId, recent);
    const retryAfterMs = recent[0] + ASSISTANT_THREAD_CREATE_WINDOW_MS - now;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  recent.push(now);
  windows.set(companyId, recent);
  return { ok: true };
}

export function resetThreadCreateLimitForTests(): void {
  windows.clear();
}
