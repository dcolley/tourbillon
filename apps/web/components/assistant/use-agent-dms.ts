'use client';

/**
 * DM-1: an agent's DMs for the assistant chat, read through the board session
 * (GET /api/companies/[companyId]/agent-mail-client). Polls every ~5s while the page is visible,
 * like the Control Pane Mail tab polls while its tab is on screen (the strip sits at the top of the
 * chat, so page visibility is what decides). Read-only: nothing here sends.
 */
import * as React from 'react';
import { agentDmsUrl, type AgentDm, type AgentDmsResponse } from '@/lib/assistant/agent-dms';

export const AGENT_DMS_POLL_MS = 5000;

export type AgentDmsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface AgentDmsState {
  mails: AgentDm[];
  status: AgentDmsStatus;
  error: string | null;
}

export interface UseAgentDmsOptions {
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}

/** One read of the agent's DMs. Throws on a non-2xx answer or a malformed body. */
export async function fetchAgentDms(
  companyId: string,
  agentId: string,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<AgentDm[]> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(agentDmsUrl(companyId, agentId), { cache: 'no-store', credentials: 'same-origin', signal: opts.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Partial<AgentDmsResponse> | null;
  return Array.isArray(data?.mails) ? data.mails : [];
}

const pageVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export function useAgentDms(
  companyId: string | null | undefined,
  agentId: string,
  opts: UseAgentDmsOptions = {},
): AgentDmsState & { refresh: () => void } {
  const intervalMs = opts.intervalMs ?? AGENT_DMS_POLL_MS;
  const fetchImpl = opts.fetchImpl;
  // State is tagged with the company / agent it was read for, so another agent never shows the
  // previous agent's DMs (it starts over as loading).
  const key = companyId ? `${companyId}\u0000${agentId}` : null;
  const [state, setState] = React.useState<AgentDmsState & { key: string | null }>({ key, mails: [], status: key ? 'loading' : 'idle', error: null });
  const [tick, setTick] = React.useState(0);
  const refresh = React.useCallback(() => setTick((t) => t + 1), []);

  React.useEffect(() => {
    if (!companyId) return;
    const readKey = `${companyId}\u0000${agentId}`;
    let alive = true;
    let inflight: AbortController | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const load = () => {
      inflight?.abort();
      const ctl = new AbortController();
      inflight = ctl;
      fetchAgentDms(companyId, agentId, { fetchImpl, signal: ctl.signal }).then(
        (mails) => {
          if (alive && inflight === ctl) setState({ key: readKey, mails, status: 'ready', error: null });
        },
        (err: unknown) => {
          if (!alive || inflight !== ctl || ctl.signal.aborted) return;
          // Keep what was shown; report the failure.
          const error = err instanceof Error ? err.message : 'Failed to load DMs';
          setState((s) => (s.key === readKey ? { ...s, status: 'error', error } : { key: readKey, mails: [], status: 'error', error }));
        },
      );
    };
    const start = () => {
      if (timer) return;
      timer = setInterval(load, intervalMs);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (pageVisible()) {
        load();
        start();
      } else stop();
    };
    load();
    if (pageVisible()) start();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive = false;
      stop();
      inflight?.abort();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [companyId, agentId, intervalMs, fetchImpl, tick]);

  if (state.key !== key) return { mails: [], status: key ? 'loading' : 'idle', error: null, refresh };
  return { mails: state.mails, status: state.status, error: state.error, refresh };
}
