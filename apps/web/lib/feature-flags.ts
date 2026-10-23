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
 * Server-side switch for the legacy Control Pane chat API (/api/chat/[agentId]/sessions/**).
 * Both CONTROL_CHAT_ENABLED (read on the server at request time) and the build-time
 * NEXT_PUBLIC_CONTROL_CHAT_ENABLED must be exactly 'true'; otherwise those routes answer 404.
 * Hiding the pane alone does not turn the routes off, so they check this on the server.
 */
export function isControlChatServerEnabled(): boolean {
  return process.env.CONTROL_CHAT_ENABLED === 'true' && isControlChatEnabled();
}
