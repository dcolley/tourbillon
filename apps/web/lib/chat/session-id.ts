/**
 * Mastra 1.81 looks sessions up by id (`getSession` / `deleteSession({ sessionId })`).
 * Before that, the live registry key was `(resourceId, scope)` and `id` could be a
 * thread id. Scope isolation stays: the session id is the resource, or
 * `resourceId::scope` when a scope is set. `threadId` only chooses the thread.
 *
 * Lives outside the `@/lib/chat` barrel because route tests replace that module
 * wholesale. Call sites that must keep working under those mocks import this file.
 */
export function chatSessionId(resourceId: string, scope?: string): string {
  return scope ? `${resourceId}::${scope}` : resourceId;
}
