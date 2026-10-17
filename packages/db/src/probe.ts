import postgres from 'postgres';
import { assertValidDatabaseUrl } from './database-url';

export const DEFAULT_DB_PROBE_TIMEOUT_MS = 10_000;

/**
 * One-shot readiness probe on its own single-connection client, so a stalled probe never ties up
 * the shared pool. Bounded by connect_timeout for the handshake and by `signal` (the caller's
 * per-attempt timeout) for anything after it: on abort the client is ended immediately, which
 * destroys the socket and rejects the pending query.
 */
export async function probeDatabase(
  opts: { url?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const url = opts.url ?? process.env.DATABASE_URL;
  assertValidDatabaseUrl(url);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DB_PROBE_TIMEOUT_MS;
  const options = {
    max: 1,
    prepare: false,
    idle_timeout: 1,
    connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    onnotice: () => undefined,
  };
  const sql = url ? postgres(url, options) : postgres(options);
  const end = () => sql.end({ timeout: 0 }).catch(() => undefined);
  opts.signal?.addEventListener('abort', () => void end(), { once: true });
  try {
    if (opts.signal?.aborted) throw new Error('database probe aborted');
    await sql`select 1`;
  } finally {
    await end();
  }
}
