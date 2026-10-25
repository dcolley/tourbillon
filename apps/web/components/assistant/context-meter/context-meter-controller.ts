/**
 * CTX-1: state for the composer's context meter (no React; tested directly).
 *
 * Loads GET …/threads/[threadId]/context. A newer load wins over an older one; a failed reload
 * keeps the last good meter (the meter is a hint, not an error surface).
 */
import type { ThreadContextMeter } from '@/lib/assistant/context-meter';

export interface ContextMeterSnapshot {
  status: 'loading' | 'ready' | 'error';
  meter: ThreadContextMeter | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ContextMeterController {
  getSnapshot(): ContextMeterSnapshot;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
}

export function contextMeterUrl(agentId: string, threadId: string): string {
  return `/api/assistant/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}/context`;
}

export function createContextMeterController(opts: {
  agentId: string;
  threadId: string;
  fetch?: FetchLike;
}): ContextMeterController {
  const f: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const url = contextMeterUrl(opts.agentId, opts.threadId);
  const listeners = new Set<() => void>();
  let snap: ContextMeterSnapshot = { status: 'loading', meter: null };
  let request = 0;
  const set = (next: ContextMeterSnapshot) => {
    snap = next;
    for (const l of listeners) l();
  };
  return {
    getSnapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load() {
      const mine = ++request;
      try {
        const res = await f(url, { cache: 'no-store' });
        if (mine !== request) return;
        if (!res.ok) {
          set({ status: snap.meter ? 'ready' : 'error', meter: snap.meter });
          return;
        }
        const body = (await res.json()) as { meter?: ThreadContextMeter };
        if (mine !== request) return;
        if (body.meter && typeof body.meter.limitTokens === 'number') set({ status: 'ready', meter: body.meter });
        else set({ status: snap.meter ? 'ready' : 'error', meter: snap.meter });
      } catch {
        if (mine === request) set({ status: snap.meter ? 'ready' : 'error', meter: snap.meter });
      }
    },
  };
}
