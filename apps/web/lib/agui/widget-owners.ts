/**
 * WID-1: which session owns each widget call it asked (in-process, next to the run claims).
 *
 * Mastra parks a suspended tool call in every session that watches the thread when the call
 * suspends, so "parked in this session" does not say who may answer it. The AG-UI route records the
 * session whose open run emitted `tool_suspended` for a widget call; only that session may answer or
 * dismiss it, and while it is pending no other session may act on the thread (abort, steer, follow
 * up, run). The owner's own behaviour is unchanged.
 *
 * Records are kept per thread after the answer so a repeat from the owner is still recognised as
 * "already answered". Bounds never drop a pending (parked) record:
 * - per thread: at most MAX_RECORDS_PER_THREAD; the oldest settled record is dropped first;
 * - overall: when more than MAX_THREADS threads have records, settled records are swept (threads
 *   with a pending widget keep it), so one company's widgets cannot evict another's.
 *
 * Owners on a dropped chat controller are gone. Every request uses the agent's cached controller, so
 * once a controller is dropped (agent model / settings change, provider toggle, cache clear) its
 * sessions can never be reached again and their parked widgets can never be answered. The registry
 * calls `retireWidgetOwnersOfController` when it drops one: the owner's parked run is aborted (which
 * drops its parked suspensions) and its records count as settled, so the thread is usable again.
 */

const MAX_RECORDS_PER_THREAD = 100;
const MAX_THREADS = 10_000;

interface ParkedView {
  suspensions?: { has(args: { toolCallId: string }): boolean };
}

interface WidgetOwnerRecord {
  owner: WeakRef<object>;
  /** The chat controller the owner session belongs to (absent when not known). */
  controller?: WeakRef<object>;
  /**
   * WID-3: the call's args as the run asked them (from `tool_suspended`), so answers can be checked
   * against what the card showed (e.g. one of the offered options). Absent when not sent or too large.
   */
  args?: Record<string, unknown>;
}

/** Largest args kept with an owner record (UTF-8 bytes of the JSON text, as the widget args cap). */
const MAX_RECORDED_ARGS_BYTES = 16 * 1024;
const utf8 = new TextEncoder();

/** A plain-object copy of `args` within the size cap, or undefined. */
function recordableArgs(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  try {
    const text = JSON.stringify(args);
    if (text === undefined || utf8.encode(text).length > MAX_RECORDED_ARGS_BYTES) return undefined;
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const g = globalThis as unknown as {
  tourbillonAguiWidgetOwners?: Map<string, Map<string, WidgetOwnerRecord>>;
  tourbillonAguiWidgetOwnersSweepAt?: number;
  tourbillonAguiRetiredControllers?: WeakSet<object>;
};

function retiredControllers(): WeakSet<object> {
  if (!g.tourbillonAguiRetiredControllers) g.tourbillonAguiRetiredControllers = new WeakSet();
  return g.tourbillonAguiRetiredControllers;
}

/** The owner session while it can still act: undefined when collected or its controller was dropped. */
function liveOwner(record: WidgetOwnerRecord): object | undefined {
  const owner = record.owner.deref();
  if (!owner || !record.controller) return owner;
  const controller = record.controller.deref();
  return controller && !retiredControllers().has(controller) ? owner : undefined;
}

function threads(): Map<string, Map<string, WidgetOwnerRecord>> {
  if (!g.tourbillonAguiWidgetOwners) g.tourbillonAguiWidgetOwners = new Map();
  return g.tourbillonAguiWidgetOwners;
}

function threadKey(resourceId: string, threadId: string): string {
  return `${resourceId}\u0000${threadId}`;
}

/** True while the owner (if still live) has the call parked. */
function isParked(record: WidgetOwnerRecord, toolCallId: string): boolean {
  const owner = liveOwner(record) as ParkedView | undefined;
  return Boolean(owner?.suspensions?.has({ toolCallId }));
}

function trimThread(bucket: Map<string, WidgetOwnerRecord>): void {
  while (bucket.size > MAX_RECORDS_PER_THREAD) {
    let victim: string | undefined;
    for (const [id, record] of bucket) {
      if (!isParked(record, id)) {
        victim = id;
        break;
      }
    }
    // Every record is pending (cannot happen with one widget per run, but stay bounded): drop the oldest.
    bucket.delete(victim ?? bucket.keys().next().value!);
  }
}

/** Drops settled records everywhere; threads left empty go too. Pending records are kept. */
function sweepSettled(): void {
  const map = threads();
  for (const [key, bucket] of map) {
    for (const [id, record] of bucket) if (!isParked(record, id)) bucket.delete(id);
    if (bucket.size === 0) map.delete(key);
  }
  g.tourbillonAguiWidgetOwnersSweepAt = Math.max(MAX_THREADS, map.size * 2);
}

/**
 * Records `session` as the owner of a widget call (first record wins; a replay keeps the owner).
 * `controller` is the chat controller the session belongs to (see `retireWidgetOwnersOfController`).
 */
export function recordWidgetOwner(
  session: object,
  resourceId: string,
  threadId: string,
  toolCallId: string,
  controller?: object,
  args?: unknown,
): void {
  const map = threads();
  const key = threadKey(resourceId, threadId);
  let bucket = map.get(key);
  if (bucket?.has(toolCallId)) return;
  if (!bucket) {
    if (map.size >= (g.tourbillonAguiWidgetOwnersSweepAt ?? MAX_THREADS)) sweepSettled();
    bucket = new Map();
    map.set(key, bucket);
  }
  const kept = recordableArgs(args);
  bucket.set(toolCallId, {
    owner: new WeakRef(session),
    ...(controller ? { controller: new WeakRef(controller) } : {}),
    ...(kept ? { args: kept } : {}),
  });
  trimThread(bucket);
}

export type WidgetOwnership = 'owner' | 'other' | 'gone' | 'unknown';

/**
 * `owner` when `session` asked this widget call, `other` when another live session did, `gone` when
 * the owner has gone (collected, or its controller was dropped), `unknown` when no AG-UI run asked it.
 */
export function widgetOwnership(session: object, resourceId: string, threadId: string, toolCallId: string): WidgetOwnership {
  const record = threads().get(threadKey(resourceId, threadId))?.get(toolCallId);
  if (!record) return 'unknown';
  const owner = liveOwner(record);
  if (!owner) return 'gone';
  return owner === session ? 'owner' : 'other';
}

/** WID-3: the args a widget call was asked with (as recorded with its owner), or undefined. */
export function widgetCallArgs(resourceId: string, threadId: string, toolCallId: string): Record<string, unknown> | undefined {
  return threads().get(threadKey(resourceId, threadId))?.get(toolCallId)?.args;
}

/** Widget calls this session asked on this thread that are still parked in it. */
export function pendingOwnedWidgetCalls(session: ParkedView & object, resourceId: string, threadId: string): string[] {
  const out: string[] = [];
  for (const [toolCallId, record] of threads().get(threadKey(resourceId, threadId)) ?? []) {
    if (liveOwner(record) === session && session.suspensions?.has({ toolCallId })) out.push(toolCallId);
  }
  return out;
}

/**
 * True when a widget asked by another session is still pending on this thread: parked in its owner,
 * or (owner gone) still parked in this session through Mastra's fan-out.
 */
export function hasOtherSessionPendingWidget(session: ParkedView & object, resourceId: string, threadId: string): boolean {
  for (const [toolCallId, record] of threads().get(threadKey(resourceId, threadId)) ?? []) {
    const owner = liveOwner(record);
    if (owner === session) continue;
    if (isParked(record, toolCallId) || (!owner && session.suspensions?.has({ toolCallId }))) return true;
  }
  return false;
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
  controller?: object,
): () => void {
  return session.subscribe((event) => {
    if (event.type !== 'tool_suspended') return;
    const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
    const toolName = typeof event.toolName === 'string' ? event.toolName : undefined;
    const eventThread = typeof event.threadId === 'string' ? event.threadId : undefined;
    if (!toolCallId || !toolName || (eventThread !== undefined && eventThread !== threadId)) return;
    if (isWidget(toolName)) recordWidgetOwner(session, resourceId, threadId, toolCallId, controller, event.args);
  });
}

/**
 * Called when a chat controller is dropped from the cache: its sessions can no longer be reached, so
 * owners on it are gone. Aborts each such owner's run that is parked on a widget (dropping the parked
 * suspensions) and leaves its records settled. Returns how many parked owner runs were aborted.
 */
export function retireWidgetOwnersOfController(controller: object): number {
  retiredControllers().add(controller);
  const aborted = new Set<object>();
  for (const bucket of threads().values()) {
    for (const [toolCallId, record] of bucket) {
      if (record.controller?.deref() !== controller) continue;
      const owner = record.owner.deref() as (ParkedView & { abort?: () => void }) | undefined;
      if (!owner || aborted.has(owner) || !owner.suspensions?.has({ toolCallId })) continue;
      aborted.add(owner);
      try {
        owner.abort?.();
      } catch (err) {
        console.warn('[agui] parked widget run not aborted on controller drop', {
          error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
        });
      }
    }
  }
  return aborted.size;
}

/** Test only: forget every record. */
export function resetWidgetOwnersForTests(): void {
  threads().clear();
  g.tourbillonAguiWidgetOwnersSweepAt = undefined;
}

/** Test only: thread count at which the next new thread triggers a sweep. */
export function widgetOwnerSweepThresholdForTests(): number {
  return g.tourbillonAguiWidgetOwnersSweepAt ?? MAX_THREADS;
}

/** Test only: number of threads with records. */
export function widgetOwnerThreadCountForTests(): number {
  return threads().size;
}
