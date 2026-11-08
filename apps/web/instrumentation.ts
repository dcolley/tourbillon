/**
 * Next.js startup hook (runs once per server process).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { logLegacyControlChatStartupWarnings } = await import('./lib/feature-flags');
  logLegacyControlChatStartupWarnings();
  // CONCIERGE-QUEUE-SIGNAL: TASK-RUNNER progress → typed task-progress signals on the
  // task's ORIGINATING free-chat thread (queueSignal; idempotent per process). The handle
  // exposes the owned psubscribe ACK (`ready`) and an idempotent `stop` for lifecycle tests;
  // production owns the bridge for the process lifetime — a failed subscribe is surfaced,
  // never fatal to boot.
  const { startTaskProgressSignalBridge } = await import('./lib/assistant/task-progress-bridge');
  const bridge = startTaskProgressSignalBridge();
  bridge.ready.catch((err) => {
    console.warn('[concierge-signal] bridge subscribe failed', err);
  });
}
