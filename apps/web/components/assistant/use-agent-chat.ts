'use client';

/**
 * AGUI-1b: React binding for the AG-UI agent chat client (lib/agui/client). Opens a thread through
 * the chat REST API, then runs turns over POST /api/agui/[agentId]. Unmounting closes the client,
 * which stops an open run on the endpoint (AG-UI client disconnect).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AgentChatClient, type AgentChatClientOptions } from '@/lib/agui/client/agent-chat-client';
import { initialAgentChatState, type AgentChatState } from '@/lib/agui/client/chat-state';
import { openAguiThread, type AguiThreadRef } from '@/lib/agui/client/thread-bootstrap';

export type AgentChatPhase = 'connecting' | 'ready' | 'error';

const noopSubscribe = () => () => {};
const initial = () => initialAgentChatState;

export interface UseAgentChatOptions {
  agentId: string;
  threadId?: string;
  /** WID-1 seam: passed through to the client. */
  tools?: AgentChatClientOptions['tools'];
  onRunEvent?: AgentChatClientOptions['onRunEvent'];
}

export function useAgentChat({ agentId, threadId, tools, onRunEvent }: UseAgentChatOptions) {
  const key = `${agentId}\u0000${threadId ?? ''}`;
  /** Result of opening the thread for `key`; anything else (older key, not yet set) reads as connecting. */
  const [setup, setSetup] = useState<{
    key: string;
    client: AgentChatClient | null;
    thread: AguiThreadRef | null;
    error: string | null;
  } | null>(null);
  const seam = useRef({ tools, onRunEvent });
  useEffect(() => {
    seam.current = { tools, onRunEvent };
  }, [tools, onRunEvent]);

  useEffect(() => {
    const ac = new AbortController();
    let created: AgentChatClient | null = null;
    openAguiThread({ agentId, threadId, signal: ac.signal }).then(
      (ref) => {
        if (ac.signal.aborted) return;
        created = new AgentChatClient({
          agentId,
          threadId: ref.threadId,
          resourceId: ref.resourceId,
          tools: seam.current.tools,
          onRunEvent: (event) => seam.current.onRunEvent?.(event),
        });
        setSetup({ key, client: created, thread: ref, error: null });
      },
      (err: unknown) => {
        if (ac.signal.aborted) return;
        setSetup({ key, client: null, thread: null, error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      ac.abort();
      created?.dispose();
    };
    // tools are read once per thread (WID-1 seam; not reactive yet).
  }, [key, agentId, threadId]);

  const current = setup?.key === key ? setup : null;
  const client = current?.client ?? null;
  const thread = current?.thread ?? null;
  const setupError = current?.error ?? null;
  const phase: AgentChatPhase = !current ? 'connecting' : current.client ? 'ready' : 'error';

  const state: AgentChatState = useSyncExternalStore(
    client?.subscribe ?? noopSubscribe,
    client?.getState ?? initial,
    initial,
  );

  const send = useCallback((text: string) => client?.send(text), [client]);
  const steer = useCallback((text: string) => client?.steer(text), [client]);
  const abort = useCallback(() => client?.abort(), [client]);
  const respondToTool = useCallback(
    (toolCallId: string, approved: boolean) => client?.respondToTool(toolCallId, approved),
    [client],
  );
  const clearError = useCallback(() => client?.clearError(), [client]);

  return { phase, setupError, thread, state, send, steer, abort, respondToTool, clearError };
}
