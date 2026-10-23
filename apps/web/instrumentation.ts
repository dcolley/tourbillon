/**
 * Next.js startup hook (runs once per server process).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { logLegacyControlChatStartupWarnings } = await import('./lib/feature-flags');
  logLegacyControlChatStartupWarnings();
}
