/**
 * Next.js instrumentation hook: register() runs once when a server instance starts.
 *
 * Only the Node.js server runtime loads the startup scheduler-key check; the edge runtime and
 * `next build` skip it (see lib/startup-scheduler-key-check.ts). It logs a warning and never throws.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { runStartupSchedulerKeyCheck } = await import('./lib/startup-scheduler-key-check');
    runStartupSchedulerKeyCheck();
  } catch {
    // Never block server start on a warning.
  }
}
