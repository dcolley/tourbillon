/**
 * WID-1: which session owns each widget call it asked (in-process, next to the run claims).
 *
 * Mastra parks a suspended tool call in every session that watches the thread when the call
 * suspends, so "parked in this session" does not say who may answer it. The AG-UI route records the
 * session whose open run emitted `tool_suspended` for a widget call; only that session may answer or
 * dismiss it. Every other session is refused and the owner's widget stays pending.
 *
 * Records are kept after the answer (bounded, oldest dropped first) so a repeat from the owner is
 * still recognised as "already answered" and a repeat from another session is still refused.
 */

const MAX_RECORDS = 5000;

interface WidgetOwnerRecord {
  owner: WeakRef<object>;
}

const g = globalThis as unknown as { tourbillonAguiWidgetOwners?: Map<string, WidgetOwnerRecord> };

function records(): Map<string, WidgetOwnerRecord> {
  if (!g.tourbillonAguiWidgetOwners) g.tourbillonAguiWidgetOwners = new Map();
  return g.tourbillonAguiWidgetOwners;
}

function key(resourceId: string, threadId: string, toolCallId: string): string {
  return `${resourceId}\u0000${threadId}\u0000${toolCallId}`;
}

/** Records `session` as the owner of a widget call (first record wins; a replay keeps the owner). */
export function recordWidgetOwner(session: object, resourceId: string, threadId: string, toolCallId: string): void {
  const map = records();
  const k = key(resourceId, threadId, toolCallId);
  if (map.has(k)) return;
  map.set(k, { owner: new WeakRef(session) });
  while (map.size > MAX_RECORDS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export type WidgetOwnership = 'owner' | 'other' | 'unknown';

/**
 * `owner` when `session` asked this widget call, `other` when another session did (or the owner has
 * gone), `unknown` when no AG-UI run asked it.
 */
export function widgetOwnership(session: object, resourceId: string, threadId: string, toolCallId: string): WidgetOwnership {
  const record = records().get(key(resourceId, threadId, toolCallId));
  if (!record) return 'unknown';
  return record.owner.deref() === session ? 'owner' : 'other';
}

/** Widget calls this session asked on this thread that are still parked in it. */
export function pendingOwnedWidgetCalls(
  session: { suspensions?: { has(args: { toolCallId: string }): boolean } },
  resourceId: string,
  threadId: string,
): string[] {
  const prefix = `${resourceId}\u0000${threadId}\u0000`;
  const out: string[] = [];
  for (const [k, record] of records()) {
    if (!k.startsWith(prefix) || record.owner.deref() !== session) continue;
    const toolCallId = k.slice(prefix.length);
    if (session.suspensions?.has({ toolCallId })) out.push(toolCallId);
  }
  return out;
}

/**
 * While an AG-UI run of `session` is open on the thread: records the session as owner of every
 * widget call it suspends there. `isWidget` says whether a tool name is a widget. Returns unsubscribe.
 */
export function trackWidgetOwners(
  session: { subscribe(listener: (event: { type: string; [k: string]: unknown }) => void): () => void },
  resourceId: string,
  threadId: string,
  isWidget: (toolName: string) => boolean,
): () => void {
  return session.subscribe((event) => {
    if (event.type !== 'tool_suspended') return;
    const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
    const toolName = typeof event.toolName === 'string' ? event.toolName : undefined;
    const eventThread = typeof event.threadId === 'string' ? event.threadId : undefined;
    if (!toolCallId || !toolName || (eventThread !== undefined && eventThread !== threadId)) return;
    if (isWidget(toolName)) recordWidgetOwner(session, resourceId, threadId, toolCallId);
  });
}

/** Test only: forget every record. */
export function resetWidgetOwnersForTests(): void {
  records().clear();
}
