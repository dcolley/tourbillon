/**
 * Bounded best-effort flushing for observability exporters.
 *
 * A collector outage (connection refused, 4xx, or a hung collector) must never turn
 * into a failed heartbeat: every flush unit runs concurrently, each individually
 * wrapped so neither a rejection nor a hang escapes. Failures surface only through
 * the warn sink; the call itself always resolves.
 */

export interface FlushUnit {
  /** Stable identity used in warn lines only — never include credentials here. */
  label: string;
  flush: () => Promise<unknown>;
}

export interface FlushUnitsOptions {
  /** Max time to wait for any single unit before warning and moving on. */
  timeoutMs: number;
  /** Sink for failure warnings (defaults to console.warn). */
  warn?: (message: string) => void;
}

const MAX_ERROR_TEXT = 300;

/**
 * Cap error text and strip URL credentials so a flush warning can never leak a
 * secret (`http://user:***@host` → `http://[redacted]@host`).
 */
export function sanitizeFlushErrorText(err: unknown): string {
  let text = err instanceof Error ? err.message : String(err);
  text = text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/g, '$1[redacted]@');
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text;
}

/**
 * Flush all units concurrently; never rejects. A unit that rejects logs a warning
 * with its label and the sanitized error; a unit that hangs for `timeoutMs` logs a
 * timeout warning and is abandoned (its eventual rejection is swallowed).
 */
export async function flushUnitsSafely(
  units: FlushUnit[],
  options: FlushUnitsOptions,
): Promise<void> {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : 5000;

  await Promise.all(
    units.map(async (unit) => {
      const work = Promise.resolve().then(() => unit.flush());
      // If we time out on the race, a later rejection of `work` would be an
      // unhandled rejection — neutralize it up front.
      work.catch(() => undefined);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });

      try {
        const outcome = await Promise.race([work.then(() => 'done' as const), timeout]);
        if (outcome === 'timeout') {
          warn(`${unit.label} flush timed out after ${timeoutMs}ms — continuing without it`);
        }
      } catch (err) {
        warn(`${unit.label} flush failed: ${sanitizeFlushErrorText(err)}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
}
