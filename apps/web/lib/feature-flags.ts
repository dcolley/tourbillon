/**
 * Build-time feature flags for the web app.
 *
 * NEXT_PUBLIC_* values are inlined into the client bundle by `next build`, so changing one
 * needs a rebuild (a restart alone is not enough). The env var must be read with a literal
 * `process.env.NEXT_PUBLIC_…` expression for Next.js to inline it.
 */

/**
 * Control Pane page/agent chat (floating chat button, popover pane and docked chat sidebar).
 * Off by default: only the exact string 'true' enables it.
 */
export function isControlChatEnabled(): boolean {
  return process.env.NEXT_PUBLIC_CONTROL_CHAT_ENABLED === 'true';
}

/**
 * The assistant (the AG-UI chat endpoint, /api/agui/[agentId]) is available unless
 * ASSISTANT_ENABLED is exactly 'false'. Read on the server at request time.
 */
export function isAssistantAvailable(): boolean {
  return process.env.ASSISTANT_ENABLED !== 'false';
}

/**
 * Server-side switch for the legacy Control Pane chat API (/api/chat/[agentId]/sessions/**).
 * On only when CONTROL_CHAT_ENABLED is exactly 'true', the build-time
 * NEXT_PUBLIC_CONTROL_CHAT_ENABLED was 'true' at build, and the assistant is not available.
 * While the assistant is available the legacy API stays off whatever its flags say (it can act on
 * the same threads as assistant runs). Hiding the pane alone does not turn the routes off, so they
 * check this on the server.
 */
export function isControlChatServerEnabled(): boolean {
  return process.env.CONTROL_CHAT_ENABLED === 'true' && isControlChatEnabled() && !isAssistantAvailable();
}

/**
 * Startup notes about the legacy Control Pane chat flags. They name the variables only, never
 * their values. Empty when no legacy flag is set.
 */
export function legacyControlChatStartupWarnings(): string[] {
  const server = process.env.CONTROL_CHAT_ENABLED === 'true';
  const build = isControlChatEnabled();
  if (!server && !build) return [];
  const prefix = '[control-chat]';
  if (isAssistantAvailable()) {
    return [
      `${prefix} Legacy Control Pane chat flags are set but ignored while the assistant is available: ` +
        'the legacy chat session API (/api/chat/<agent>/sessions/...) stays off (404). ' +
        'It can only be used with ASSISTANT_ENABLED=false.',
    ];
  }
  if (!server || !build) {
    return [
      `${prefix} The legacy chat session API needs both CONTROL_CHAT_ENABLED and ` +
        'NEXT_PUBLIC_CONTROL_CHAT_ENABLED (at build time) set to "true"; it stays off (404).',
    ];
  }
  return [
    `${prefix} The assistant is off (ASSISTANT_ENABLED=false) and the legacy chat session API is on.`,
  ];
}

/** Logs legacyControlChatStartupWarnings() once per process (called from instrumentation). */
export function logLegacyControlChatStartupWarnings(log: (message: string) => void = console.warn): void {
  const g = globalThis as { tourbillonControlChatStartupLogged?: boolean };
  if (g.tourbillonControlChatStartupLogged) return;
  g.tourbillonControlChatStartupLogged = true;
  for (const message of legacyControlChatStartupWarnings()) log(message);
}
