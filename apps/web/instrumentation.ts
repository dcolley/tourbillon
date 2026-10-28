/**
 * Next.js startup hook (runs once per server process).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { logLegacyControlChatStartupWarnings } = await import('./lib/feature-flags');
  logLegacyControlChatStartupWarnings();
  // CONCIERGE-QUEUE-SIGNAL: TASK-RUNNER progress → typed task-progress signals on the
  // agent's pinned free-chat thread (queueSignal; idempotent per process).
  const { startTaskProgressSignalBridge } = await import('./lib/assistant/task-progress-bridge');
  startTaskProgressSignalBridge();
}
