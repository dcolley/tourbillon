'use client';

/**
 * AGUI-1b: React binding for the AG-UI agent chat client (lib/agui/client). Opens a thread through
 * the assistant thread API, then runs turns over POST /api/agui/[agentId]. Unmounting closes the
 * client, which stops an open run on the endpoint (AG-UI client disconnect).
 * P0 (agent switch): each mount loads the thread's persisted messages fresh before the chat is ready
 * (connectAgentChat → AgentChatClient.open), so returning to an agent shows the conversation up to now.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AgentChatClient, type AgentChatClientOptions, type AgentChatSendOptions } from '@/lib/agui/client/agent-chat-client';
import { initialAgentChatState, type AgentChatState } from '@/lib/agui/client/chat-state';
import { openAguiThread, type AguiThreadRef } from '@/lib/agui/client/thread-bootstrap';

export type AgentChatPhase = 'connecting' | 'ready' | 'error';

const noopSubscribe = () => () => {};
const initial = () => initialAgentChatState;

/**
 * Thread lookups in flight, by agent + thread. A remount for the same key (React strict mode runs
 * effects twice in development) reuses the pending lookup instead of starting another one, so a
 * new thread is not created twice.
 */
const inflight = new Map<string, Promise<AguiThreadRef>>();

function openThreadOnce(key: string, agentId: string, threadId: string | undefined): Promise<AguiThreadRef> {
  let pending = inflight.get(key);
  if (!pending) {
    pending = openAguiThread({ agentId, threadId });
    inflight.set(key, pending);
    const clear = () => {
      if (inflight.get(key) === pending) inflight.delete(key);
    };
    pending.then(clear, clear);
  }
  return pending;
}

export interface ConnectAgentChatOptions {
  /** Agent + thread key (see useAgentChat); lookups for the same key in flight are shared. */
  key: string;
  agentId: string;
  threadId?: string;
  tools?: AgentChatClientOptions['tools'];
  onRunEvent?: AgentChatClientOptions['onRunEvent'];
  /** The thread is open and its messages up to now are shown in `client`. */
  onReady: (client: AgentChatClient, thread: AguiThreadRef) => void;
  onError: (message: string) => void;
  /** Test seams. */
  openThread?: (key: string, agentId: string, threadId: string | undefined) => Promise<AguiThreadRef>;
  createClient?: (opts: AgentChatClientOptions) => AgentChatClient;
}

/**
 * One mount of the agent chat (the body of useAgentChat's effect; returns its cleanup): opens the
 * thread, then a new client for it that loads the thread's messages fresh from the server
 * (AgentChatClient.open → loadHistory, then restorePending) before the chat is shown as ready.
 * P0 (agent switch): every mount (switching agents remounts the chat, see assistant-route-view.tsx)
 * builds a new client and fetches again, so returning to an agent shows everything up to now,
 * including turns written while the user was on another agent. Cleanup disposes the client.
 */
export function connectAgentChat(opts: ConnectAgentChatOptions): () => void {
  let cancelled = false;
  let created: AgentChatClient | null = null;
  const open = opts.openThread ?? openThreadOnce;
  const create = opts.createClient ?? ((o: AgentChatClientOptions) => new AgentChatClient(o));
  open(opts.key, opts.agentId, opts.threadId).then(
    async (ref) => {
      if (cancelled) return;
      const client = create({
        agentId: opts.agentId,
        threadId: ref.threadId,
        tools: opts.tools,
        onRunEvent: opts.onRunEvent,
      });
      created = client;
      await client.open();
      if (cancelled) return;
      opts.onReady(client, ref);
    },
    (err: unknown) => {
      if (cancelled) return;
      opts.onError(err instanceof Error ? err.message : String(err));
    },
  );
  return () => {
    cancelled = true;
    created?.dispose();
  };
}

export interface UseAgentChatOptions {
  agentId: string;
  threadId?: string;
  /** WID-1 seam: passed through to the client. */
  tools?: AgentChatClientOptions['tools'];
  onRunEvent?: AgentChatClientOptions['onRunEvent'];
  /** Called once the thread is open (e.g. to put its id in the page URL). */
  onThreadOpened?: (thread: AguiThreadRef) => void;
}

export function useAgentChat({ agentId, threadId, tools, onRunEvent, onThreadOpened }: UseAgentChatOptions) {
  const key = `${agentId}\u0000${threadId ?? ''}`;
  /** Result of opening the thread for `key`; anything else (older key, not yet set) reads as connecting. */
  const [setup, setSetup] = useState<{
    key: string;
    client: AgentChatClient | null;
    thread: AguiThreadRef | null;
    error: string | null;
  } | null>(null);
  const seam = useRef({ tools, onRunEvent, onThreadOpened });
  useEffect(() => {
    seam.current = { tools, onRunEvent, onThreadOpened };
  }, [tools, onRunEvent, onThreadOpened]);

  useEffect(
    () =>
      connectAgentChat({
        key,
        agentId,
        threadId,
        tools: seam.current.tools,
        onRunEvent: (event) => seam.current.onRunEvent?.(event),
        onReady: (client, ref) => {
          setSetup({ key, client, thread: ref, error: null });
          seam.current.onThreadOpened?.(ref);
        },
        onError: (error) => setSetup({ key, client: null, thread: null, error }),
      }),
    // tools are read once per thread (WID-1 seam; not reactive yet).
    [key, agentId, threadId],
  );

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

  const send = useCallback((text: string, opts?: AgentChatSendOptions) => client?.send(text, opts), [client]);
  const steer = useCallback((text: string, opts?: AgentChatSendOptions) => client?.steer(text, opts), [client]);
  const abort = useCallback(() => client?.abort(), [client]);
  const respondToTool = useCallback(
    (toolCallId: string, approved: boolean) => client?.respondToTool(toolCallId, approved),
    [client],
  );
  const answerWidget = useCallback(
    (toolCallId: string, answer: unknown) => client?.answerWidget(toolCallId, answer),
    [client],
  );
  const dismissWidget = useCallback((toolCallId: string) => client?.dismissWidget(toolCallId), [client]);
  const clearError = useCallback(() => client?.clearError(), [client]);

  return { phase, setupError, thread, state, send, steer, abort, respondToTool, answerWidget, dismissWidget, clearError };
}
