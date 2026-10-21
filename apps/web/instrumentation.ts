/**
 * Next.js instrumentation hook: register() runs once when a server instance starts.
 *
 * Only the Node.js server runtime loads the startup secret check; the edge runtime and
 * `next build` skip it (see lib/startup-secret-check.ts). It logs a warning and never throws.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { runStartupSecretCheck } = await import('./lib/startup-secret-check');
    runStartupSecretCheck();
  } catch {
    // Never block server start on a warning.
  }
}
