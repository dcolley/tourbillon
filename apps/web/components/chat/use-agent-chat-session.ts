'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { stripDashboardContext } from '@/lib/chat/dashboard-context';

export type ChatContextType = 'free' | 'issue' | 'project' | 'goal' | 'heartbeat' | 'agent' | 'board';

export interface ChatThreadInfo {
  id: string;
  title?: string;
  tags?: Record<string, string>;
  updatedAt?: string;
  createdAt?: string;
}

export interface ChatMessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ChatMessage {
  id: string;
  role: string;
  content: { format?: number; parts?: ChatMessagePart[]; [key: string]: unknown };
  createdAt?: string;
}

export interface ChatPendingApproval {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ChatAgentOption {
  id: string;
  name: string;
  urlKey: string;
  modelId?: string | null;
  providerName?: string | null;
  providerType?: string | null;
}

function partText(part: ChatMessagePart): string {
  if (part.type === 'text' && typeof part.text === 'string') {
    return part.text;
  }
  if (part.type === 'data-user-message') {
    const data = part.data as { contents?: unknown } | undefined;
    if (typeof data?.contents === 'string') return data.contents;
    if (typeof part.contents === 'string') return part.contents;
  }
  return '';
}

function messageText(message: ChatMessage): string {
  const parts = message.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(partText).filter(Boolean).join('');
}

export function chatMessagePlainText(message: ChatMessage): string {
  return stripDashboardContext(messageText(message));
}

/** Live SSE user turns arrive as `signal` + `data-user-message`, not `role: user`. */
export function isChatUserMessage(message: ChatMessage): boolean {
  if (message.role === 'user') return true;
  if (message.role !== 'signal') return false;
  const parts = message.content?.parts;
  if (!Array.isArray(parts)) return false;
  return parts.some(
    (p) =>
      p.type === 'data-user-message' ||
      (p.type === 'text' && typeof p.text === 'string' && p.text.length > 0),
  );
}

function messageTimeMs(message: ChatMessage): number {
  if (!message.createdAt) return 0;
  const t = Date.parse(message.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

/** Oldest → newest (stable by id when timestamps match). */
export function sortMessagesAscending(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((a, b) => {
    const delta = messageTimeMs(a) - messageTimeMs(b);
    if (delta !== 0) return delta;
    return a.id.localeCompare(b.id);
  });
}

export function formatChatMessageDateTime(iso?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function encodeResourceId(resourceId: string): string {
  return encodeURIComponent(resourceId);
}

function sessionBase(agentId: string, resourceId: string): string {
  return `/api/chat/${encodeURIComponent(agentId)}/sessions/${encodeResourceId(resourceId)}`;
}

function sessionScopeFor(contextType: ChatContextType, contextId?: string): string {
  return contextId ? `${contextType}:${contextId}` : contextType;
}

export function useAgentChatSession(options: {
  agentId: string;
  agentName?: string;
  open: boolean;
  contextType?: ChatContextType;
  contextId?: string;
  contextTitle?: string;
  onAgentSwitch?: (agentId: string, agentName: string) => void;
  activeCompanyId: string | null;
}) {
  const {
    agentId: initialAgentId,
    agentName: initialAgentName,
    open,
    contextType = 'free',
    contextId,
    contextTitle,
    onAgentSwitch,
    activeCompanyId: serverActiveCompanyId,
  } = options;

  const [activeAgentId, setActiveAgentId] = useState(initialAgentId);
  const [activeAgentName, setActiveAgentName] = useState(initialAgentName ?? '');
  const [agentOptions, setAgentOptions] = useState<ChatAgentOption[]>([]);
  const [userPinnedAgent, setUserPinnedAgent] = useState(false);

  const [resourceId, setResourceId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ChatThreadInfo[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<ChatPendingApproval | null>(null);
  const [input, setInput] = useState('');
  const [trackedCompanyId, setTrackedCompanyId] = useState<string | null>(serverActiveCompanyId);

  const abortRef = useRef<AbortController | null>(null);
  const resourceIdRef = useRef<string | null>(null);
  const threadIdRef = useRef<string | null>(null);
  const agentIdRef = useRef(activeAgentId);

  useEffect(() => {
    resourceIdRef.current = resourceId;
  }, [resourceId]);
  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);
  useEffect(() => {
    agentIdRef.current = activeAgentId;
  }, [activeAgentId]);

  // Only rebind to page default agent when nothing is pinned by the user.
  useEffect(() => {
    if (!userPinnedAgent) {
      setActiveAgentId(initialAgentId);
      setActiveAgentName(initialAgentName ?? '');
    }
  }, [initialAgentId, initialAgentName, userPinnedAgent]);

  // Changing dashboard context must not reuse another page's resource/thread.
  useEffect(() => {
    setResourceId(null);
    setThreadId(null);
    resourceIdRef.current = null;
    threadIdRef.current = null;
    setMessages([]);
    setThreads([]);
  }, [contextType, contextId]);

  // Reset all session state when server-side active company changes
  useEffect(() => {
    if (trackedCompanyId !== null && serverActiveCompanyId !== trackedCompanyId) {
      abortRef.current?.abort();
      setActiveAgentId(initialAgentId);
      setActiveAgentName(initialAgentName ?? '');
      setResourceId(null);
      setThreadId(null);
      resourceIdRef.current = null;
      threadIdRef.current = null;
      setMessages([]);
      setThreads([]);
      setAgentOptions([]);
      setUserPinnedAgent(false);
      setRunning(false);
      setConnecting(false);
      setError(null);
      setPendingApproval(null);
      setInput('');
    }
    setTrackedCompanyId(serverActiveCompanyId);
  }, [serverActiveCompanyId, trackedCompanyId, initialAgentId, initialAgentName]);

  const contextTags = useCallback((): Record<string, string> => {
    const tags: Record<string, string> = { kind: 'chat', contextType };
    if (contextId) tags.contextId = contextId;
    return tags;
  }, [contextType, contextId]);


  const loadThreads = useCallback(
    async (agentKey: string, rid: string, tags?: Record<string, string>) => {
      const params = new URLSearchParams();
      if (tags && Object.keys(tags).length > 0) {
        params.set('tags', JSON.stringify(tags));
      }
      params.set('sessionScope', sessionScopeFor(contextType, contextId));
      const qs = `?${params}`;
      const res = await fetch(`${sessionBase(agentKey, rid)}/threads${qs}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Failed to list threads');
      const data = (await res.json()) as { threads: ChatThreadInfo[] };
      setThreads(data.threads);
      return data.threads;
    },
    [contextId, contextType],
  );

  const loadMessages = useCallback(
    async (agentKey: string, rid: string, tid: string) => {
      const res = await fetch(`${sessionBase(agentKey, rid)}/threads/${encodeURIComponent(tid)}/messages?sessionScope=${encodeURIComponent(sessionScopeFor(contextType, contextId))}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Failed to load messages');
      const data = (await res.json()) as { messages: ChatMessage[] };
      const ordered = sortMessagesAscending(data.messages);
      setMessages(ordered);
      return ordered;
    },
    [contextId, contextType],
  );

  const mergeMessage = useCallback((incoming: ChatMessage) => {
    setMessages((prev) => {
      const withTimestamp: ChatMessage = {
        ...incoming,
        createdAt:
          incoming.createdAt ??
          prev.find((m) => m.id === incoming.id)?.createdAt ??
          new Date().toISOString(),
      };

      // Drop optimistic local bubbles once the real stream message arrives.
      const incomingText = chatMessagePlainText(withTimestamp);
      let base = prev;
      if (incomingText && isChatUserMessage(withTimestamp)) {
        base = prev.filter(
          (m) =>
            !(
              m.id.startsWith('local-') &&
              chatMessagePlainText(m) === incomingText
            ),
        );
      }

      const idx = base.findIndex((m) => m.id === incoming.id);
      if (idx === -1) return sortMessagesAscending([...base, withTimestamp]);
      const next = [...base];
      next[idx] = withTimestamp;
      return sortMessagesAscending(next);
    });
  }, []);

  const subscribeStream = useCallback(
    async (agentKey: string, rid: string) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const scope = sessionScopeFor(contextType, contextId);

      const connect = async () => {
        const res = await fetch(`${sessionBase(agentKey, rid)}/stream?sessionScope=${encodeURIComponent(scope)}`, {
            signal: ac.signal,
            headers: { Accept: 'text/event-stream' },
          },
        );
        if (!res.ok || !res.body) {
          throw new Error('Failed to open chat stream');
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!ac.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const raw = line.slice(5).trim();
              if (!raw) continue;
              let event: { type?: string; [key: string]: unknown };
              try {
                event = JSON.parse(raw) as typeof event;
              } catch {
                continue;
              }

              if (
                event.type === 'message_start' ||
                event.type === 'message_update' ||
                event.type === 'message_end'
              ) {
                const message = event.message as ChatMessage | undefined;
                if (message?.id) mergeMessage(message);
              } else if (event.type === 'display_state_changed') {
                const ds = event.displayState as { isRunning?: boolean } | undefined;
                setRunning(ds?.isRunning === true);
              } else if (event.type === 'agent_start') {
                setRunning(true);
              } else if (event.type === 'agent_end') {
                setRunning(false);
                setPendingApproval(null);
              } else if (event.type === 'tool_approval_required') {
                setPendingApproval({
                  toolCallId: String(event.toolCallId ?? ''),
                  toolName: String(event.toolName ?? 'tool'),
                  args: event.args,
                });
              } else if (event.type === 'thread_changed') {
                const tid = event.threadId as string | undefined;
                if (tid) {
                  setThreadId(tid);
                  const currentRid = resourceIdRef.current;
                  if (currentRid) void loadMessages(agentKey, currentRid, tid);
                }
              } else if (event.type === 'error') {
                const errObj = event.error as { message?: string } | string | undefined;
                const msg =
                  typeof errObj === 'string'
                    ? errObj
                    : errObj?.message ?? 'Chat stream error';
                setError(msg);
              }
            }
          }
        }

        if (!ac.signal.aborted) {
          const tid = threadIdRef.current;
          if (tid) await loadMessages(agentKey, rid, tid);
          const stateRes = await fetch(`${sessionBase(agentKey, rid)}?sessionScope=${encodeURIComponent(scope)}`);
          if (stateRes.ok) {
            const state = (await stateRes.json()) as { running?: boolean };
            setRunning(state.running === true);
          }
          await new Promise((r) => setTimeout(r, 1000));
          if (!ac.signal.aborted) await connect();
        }
      };

      void connect().catch((err) => {
        if (ac.signal.aborted) return;
        // Clear running state when stream errors (don't leave silent clocks)
        setRunning(false);
        setError(err instanceof Error ? err.message : String(err));
      });
    },
    [contextId, contextType, loadMessages, mergeMessage],
  );

  const bindThread = useCallback(
    async (agentKey: string, rid: string, tid: string) => {
      const scope = sessionScopeFor(contextType, contextId);
      const res = await fetch(`${sessionBase(agentKey, rid)}/thread?sessionScope=${encodeURIComponent(scope)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId: tid }),
        },
      );
      if (!res.ok) {
        throw new Error((await res.json().catch(() => ({}))).error ?? 'Failed to switch thread');
      }
      setThreadId(tid);
      await loadMessages(agentKey, rid, tid);
    },
    [contextId, contextType, loadMessages],
  );

  const bootstrap = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const agentKey = activeAgentId;
      const tags = contextTags();
      const scope = sessionScopeFor(contextType, contextId);
      const createRes = await fetch(`/api/chat/${encodeURIComponent(agentKey)}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tags,
          sessionScope: scope,
          ...(threadIdRef.current ? { threadId: threadIdRef.current } : {}),
          ...(resourceIdRef.current ? { resourceId: resourceIdRef.current } : {}),
        }),
      });
      if (!createRes.ok) {
        throw new Error((await createRes.json().catch(() => ({}))).error ?? 'Failed to start chat');
      }
      const created = (await createRes.json()) as {
        resourceId: string;
        threadId?: string;
        agentName?: string;
      };
      setResourceId(created.resourceId);
      if (created.agentName) setActiveAgentName(created.agentName);

      const listed = await loadThreads(agentKey, created.resourceId, tags);
      // Never trust createSession's auto-bound thread unless it matches context tags.
      let tid =
        (created.threadId && listed.some((t) => t.id === created.threadId)
          ? created.threadId
          : null) ??
        listed[0]?.id ??
        null;

      if (!tid) {
        const newRes = await fetch(`${sessionBase(agentKey, created.resourceId)}/threads?sessionScope=${encodeURIComponent(scope)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: 'New chat',
              tags,
            }),
          },
        );
        if (!newRes.ok) {
          throw new Error((await newRes.json().catch(() => ({}))).error ?? 'Failed to create thread');
        }
        const thread = (await newRes.json()) as ChatThreadInfo;
        tid = thread.id;
        await loadThreads(agentKey, created.resourceId, tags);
      }

      if (tid) {
        await bindThread(agentKey, created.resourceId, tid);
      }

      const stateRes = await fetch(`${sessionBase(agentKey, created.resourceId)}?sessionScope=${encodeURIComponent(scope)}`);
      if (stateRes.ok) {
        const state = (await stateRes.json()) as { running?: boolean };
        setRunning(state.running === true);
      }

      await subscribeStream(agentKey, created.resourceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }, [
    activeAgentId,
    bindThread,
    contextId,
    contextTags,
    contextTitle,
    contextType,
    loadThreads,
    subscribeStream,
  ]);

  useEffect(() => {
    if (!open || !activeAgentId) {
      abortRef.current?.abort();
      return;
    }
    void bootstrap();
    return () => {
      abortRef.current?.abort();
    };
    // Re-bootstrap when pane opens, context changes, or agent/model changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeAgentId, contextType, contextId]);

  useEffect(() => {
    if (!open) return;
    void fetch('/api/chat/agents')
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { agents: ChatAgentOption[] };
        setAgentOptions(data.agents ?? []);
      })
      .catch(() => undefined);
  }, [open, serverActiveCompanyId]);

  const refetchAgents = useCallback(() => {
    if (!open) return;
    void fetch('/api/chat/agents')
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { agents: ChatAgentOption[] };
        setAgentOptions(data.agents ?? []);
      })
      .catch(() => undefined);
  }, [open]);

  // Refetch agent list when model settings are saved (cross-window communication).
  useEffect(() => {
    if (!open) return;
    const handler = () => {
      void refetchAgents();
    };
    window.addEventListener('tourbillon:agent-settings-saved', handler);
    return () => {
      window.removeEventListener('tourbillon:agent-settings-saved', handler);
    };
  }, [open, refetchAgents]);


  const selectThread = useCallback(
    async (tid: string) => {
      const rid = resourceIdRef.current;
      if (!rid) return;
      setError(null);
      try {
        await bindThread(activeAgentId, rid, tid);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [activeAgentId, bindThread],
  );

  const newThread = useCallback(async () => {
    const rid = resourceIdRef.current;
    if (!rid) return;
    setError(null);
    const tags = contextTags();
    const scope = sessionScopeFor(contextType, contextId);
    const res = await fetch(`${sessionBase(activeAgentId, rid)}/threads?sessionScope=${encodeURIComponent(scope)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New chat', tags }),
      },
    );
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Failed to create thread');
      return;
    }
    const thread = (await res.json()) as ChatThreadInfo;
    await loadThreads(activeAgentId, rid, tags);
    setThreadId(thread.id);
    setMessages([]);
  }, [
    activeAgentId,
    contextId,
    contextTags,
    contextTitle,
    contextType,
    loadThreads,
  ]);

  const renameThread = useCallback(
    async (tid: string, title: string) => {
      const rid = resourceIdRef.current;
      if (!rid) return;
      const nextTitle = title.trim();
      if (!nextTitle) throw new Error('Title is required');
      setError(null);
      const scope = sessionScopeFor(contextType, contextId);
      const res = await fetch(
        `${sessionBase(activeAgentId, rid)}/threads/${encodeURIComponent(tid)}?sessionScope=${encodeURIComponent(scope)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: nextTitle }),
        },
      );
      if (!res.ok) {
        throw new Error((await res.json().catch(() => ({}))).error ?? 'Failed to rename chat');
      }
      await loadThreads(activeAgentId, rid, contextTags());
    },
    [activeAgentId, contextId, contextTags, contextType, loadThreads],
  );

  const deleteThread = useCallback(
    async (tid: string) => {
      const rid = resourceIdRef.current;
      if (!rid) return;
      setError(null);
      const scope = sessionScopeFor(contextType, contextId);
      const tags = contextTags();
      const wasCurrent = threadIdRef.current === tid;
      const res = await fetch(
        `${sessionBase(activeAgentId, rid)}/threads/${encodeURIComponent(tid)}?sessionScope=${encodeURIComponent(scope)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        throw new Error((await res.json().catch(() => ({}))).error ?? 'Failed to delete chat');
      }
      const listed = await loadThreads(activeAgentId, rid, tags);
      if (!wasCurrent) return;

      const next = listed[0];
      if (next) {
        await bindThread(activeAgentId, rid, next.id);
      } else {
        setThreadId(null);
        setMessages([]);
      }
    },
    [activeAgentId, bindThread, contextId, contextTags, contextType, loadThreads],
  );

  const switchAgent = useCallback(
    async (nextAgentId: string, nextAgentName: string) => {
      if (nextAgentId === activeAgentId) return;
      setActiveAgentId(nextAgentId);
      setActiveAgentName(nextAgentName);
      setUserPinnedAgent(true);
      onAgentSwitch?.(nextAgentId, nextAgentName);
        // bootstrap effect re-runs with same resource/thread refs when possible
    },
    [activeAgentId, onAgentSwitch],
  );


  const sendMessage = useCallback(
    async (text: string) => {
      const rid = resourceIdRef.current;
      const tid = threadIdRef.current;
      if (!rid || !text.trim()) return;
      setError(null);
      const trimmed = text.trim();
      setInput('');

      // Check if this is the first user message in the thread.
      const hasUserMessages = messages.some((m) => isChatUserMessage(m));
      const shouldUpdateTitle = !hasUserMessages && tid;

      // Optimistic bubble so the turn shows before SSE / hydrate.
      // randomUUID needs a secure context; fall back on LAN/http.
      const optimisticId = `local-${
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`
      }`;
      mergeMessage({
        id: optimisticId,
        role: 'user',
        content: { format: 2, parts: [{ type: 'text', text: trimmed }] },
        createdAt: new Date().toISOString(),
      });

      const path = running ? 'follow-up' : 'messages';
      const scope = sessionScopeFor(contextType, contextId);
      const res = await fetch(`${sessionBase(activeAgentId, rid)}/${path}?sessionScope=${encodeURIComponent(scope)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: trimmed,
            context: {
              contextType,
              ...(contextId ? { contextId } : {}),
              ...(contextTitle ? { contextTitle } : {}),
            },
          }),
        },
      );
      if (!res.ok) {
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
        setError((await res.json().catch(() => ({}))).error ?? 'Failed to send');
        setInput(trimmed);
        return;
      }

      // Auto-update thread title to first user message (truncated to ~40 chars).
      if (shouldUpdateTitle) {
        const titleText = trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
        try {
          await renameThread(tid, titleText);
        } catch {
          // Non-blocking: if rename fails, the thread keeps its default title.
        }
      }
    },
    [activeAgentId, contextId, contextTitle, contextType, mergeMessage, messages, renameThread, running],
  );

  const abort = useCallback(async () => {
    const rid = resourceIdRef.current;
    if (!rid) return;
    const scope = sessionScopeFor(contextType, contextId);
    await fetch(`${sessionBase(activeAgentId, rid)}/abort?sessionScope=${encodeURIComponent(scope)}`, { method: 'POST' },
    );
  }, [activeAgentId, contextId, contextType]);

  const steer = useCallback(
    async (text: string) => {
      const rid = resourceIdRef.current;
      if (!rid || !text.trim()) return;
      const scope = sessionScopeFor(contextType, contextId);
      const res = await fetch(`${sessionBase(activeAgentId, rid)}/steer?sessionScope=${encodeURIComponent(scope)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text.trim(),
            context: {
              contextType,
              ...(contextId ? { contextId } : {}),
              ...(contextTitle ? { contextTitle } : {}),
            },
          }),
        },
      );
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'Failed to steer');
      } else {
        setInput('');
      }
    },
    [activeAgentId, contextId, contextTitle, contextType],
  );

  const respondApproval = useCallback(
    async (approved: boolean) => {
      const rid = resourceIdRef.current;
      if (!rid || !pendingApproval) return;
      const scope = sessionScopeFor(contextType, contextId);
      const res = await fetch(`${sessionBase(activeAgentId, rid)}/tool-approval?sessionScope=${encodeURIComponent(scope)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolCallId: pendingApproval.toolCallId, approved }),
        },
      );
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'Failed to respond');
      } else {
        setPendingApproval(null);
      }
    },
    [activeAgentId, contextId, contextType, pendingApproval],
  );

  return {
    resourceId,
    threadId,
    threads,
    messages,
    running,
    connecting,
    error,
    pendingApproval,
    input,
    setInput,
    selectThread,
    newThread,
    renameThread,
    deleteThread,
    sendMessage,
    abort,
    steer,
    respondApproval,
    activeAgentId,
    activeAgentName,
    agentOptions,
    switchAgent,
    chatMessagePlainText: messageText,
  };
}
