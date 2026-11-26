/**
 * P0 (agent switch): the assistant chat's transcript comes from the thread's persisted messages.
 * A chat client only receives the events of the runs it streams itself, so without this a chat that
 * is opened again (switching agents in the sidebar, a reload) showed none of the earlier turns, nor
 * anything the agent wrote while the user was elsewhere. The chat now loads the thread's messages
 * every time it opens (GET /api/assistant/agents/[agentId]/threads/[threadId]/messages, never cached)
 * and shows them as chat items before any new run.
 *
 * Messages are Mastra v2 memory messages (`content.parts`: text, reasoning, tool-invocation, …).
 */
import { stripDashboardContext } from '@/lib/chat/dashboard-context';
import type { AgentChatItem } from './chat-state';
import { AguiThreadBootstrapError, isUsableAguiId } from './thread-bootstrap';

export interface StoredThreadMessage {
  id: string;
  role: string;
  content: unknown;
  createdAt?: string;
  type?: string;
}

type Part = { type?: unknown; [key: string]: unknown };

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function partsOf(content: unknown): Part[] | null {
  const parts = (content as { parts?: unknown } | null | undefined)?.parts;
  return Array.isArray(parts) ? (parts.filter((p) => p && typeof p === 'object') as Part[]) : null;
}

/** Text of a message without parts (`content` a string, or `content.content` a string). */
function plainContent(content: unknown): string {
  if (typeof content === 'string') return content;
  const inner = (content as { content?: unknown } | null | undefined)?.content;
  return typeof inner === 'string' ? inner : '';
}

function userText(message: StoredThreadMessage): string {
  const parts = partsOf(message.content);
  if (!parts) return plainContent(message.content);
  return parts
    .map((p) => {
      if (p.type === 'text' && typeof p.text === 'string') return p.text;
      if (p.type === 'data-user-message') {
        const data = p.data as { contents?: unknown } | undefined;
        if (typeof data?.contents === 'string') return data.contents;
        if (typeof p.contents === 'string') return p.contents;
      }
      return '';
    })
    .join('');
}

function reasoningText(part: Part): string {
  if (typeof part.reasoning === 'string' && part.reasoning) return part.reasoning;
  if (typeof part.text === 'string' && part.text) return part.text;
  const details = Array.isArray(part.details) ? part.details : [];
  return details
    .map((d) => ((d as { type?: unknown; text?: unknown })?.type === 'text' ? String((d as { text?: unknown }).text ?? '') : ''))
    .join('');
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result) ?? '';
  } catch {
    return String(result);
  }
}

function argsText(args: unknown): string {
  if (args === undefined || args === null) return '{}';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args);
  } catch {
    return '{}';
  }
}

/** Assistant message → text / reasoning / tool items, with ids as the live stream names them. */
function assistantItems(message: StoredThreadMessage): AgentChatItem[] {
  const parts = partsOf(message.content);
  if (!parts) {
    const text = plainContent(message.content);
    return text ? [{ kind: 'assistant', id: message.id, text, streaming: false }] : [];
  }
  const out: AgentChatItem[] = [];
  // Same segment ids as lib/agui/session-events.ts (segmentId): one counter per message for text and
  // reasoning segments; a text segment that comes first is the message id, any other segment
  // `<id>:<kind>:<n>` (lib/assistant/feedback.ts maps them back to the message id).
  let segments = 0;
  const segmentId = (kind: 'text' | 'reasoning') => {
    const n = segments++;
    return kind === 'text' && n === 0 ? message.id : `${message.id}:${kind}:${n}`;
  };
  let last: 'text' | 'reasoning' | 'other' = 'other';
  for (const part of parts) {
    if (part.type === 'text') {
      const text = typeof part.text === 'string' ? part.text : '';
      if (!text) continue;
      const prev = out[out.length - 1];
      if (last === 'text' && prev?.kind === 'assistant') {
        out[out.length - 1] = { ...prev, text: prev.text + text };
      } else {
        out.push({ kind: 'assistant', id: segmentId('text'), text, streaming: false });
      }
      last = 'text';
    } else if (part.type === 'reasoning') {
      const text = reasoningText(part);
      if (!text) continue;
      const prev = out[out.length - 1];
      if (last === 'reasoning' && prev?.kind === 'reasoning') {
        out[out.length - 1] = { ...prev, text: prev.text + text };
      } else {
        out.push({ kind: 'reasoning', id: segmentId('reasoning'), text, streaming: false });
      }
      last = 'reasoning';
    } else if (part.type === 'tool-invocation') {
      const inv = (part.toolInvocation ?? {}) as Record<string, unknown>;
      const id = str(inv.toolCallId);
      if (!id) continue;
      const done = inv.state === 'result';
      out.push({
        kind: 'tool',
        id,
        name: str(inv.toolName) ?? 'tool',
        argsText: argsText(inv.args),
        // Without a stored result the call has not finished (or still waits on a card: restorePending
        // marks those suspended again once the history is shown).
        status: done ? 'done' : 'running',
        ...(done ? { result: resultText(inv.result) } : {}),
        parentMessageId: message.id,
      });
      last = 'other';
    } else {
      // step-start, source, file, data-*: not shown in the assistant chat.
      if (part.type !== 'step-start') last = 'other';
    }
  }
  return out;
}

const isUserTurn = (m: StoredThreadMessage) => m.role === 'user' || m.role === 'signal';

/**
 * TB-363 (R1): a persisted task-progress signal (role 'signal') is the runner/tool fan-out's
 * notice row — Mastra stores it as a `data-signal` part (or, in raw memory rows, under
 * `content.metadata.signal`) with tagName 'task-progress' and attributes {taskId, runId,
 * stage, status}. Base rendered these as NOTHING (userText reads only text /
 * data-user-message, so the row's text is '' and the user-turn branch dropped it). Surface it
 * as its own notice item; the model may say nothing, the notice still shows.
 */
function signalBag(message: StoredThreadMessage): { contents?: unknown; tagName?: unknown; type?: unknown; attributes?: unknown } | null {
  const parts = partsOf(message.content);
  const signalPart = parts?.find(
    (p) => p.type === 'data-signal' && ((p.data as Record<string, unknown> | undefined)?.tagName ?? (p as Record<string, unknown>).tagName) === 'task-progress',
  );
  if (signalPart) return (signalPart.data ?? signalPart) as Record<string, unknown>;
  const meta = (message.content as { metadata?: { signal?: Record<string, unknown> } } | null | undefined)?.metadata?.signal;
  if (meta && (meta.tagName ?? meta.type) === 'task-progress') {
    // Mastra 1.81 stores an accepted signal as role 'signal' with a plain TEXT part plus
    // content.metadata.signal ({id,type,tagName,createdAt,acceptedAt,attributes}) — the human
    // line is the text part (verified against real PG rows in the TN cells), and the row also
    // carries top-level `type: 'task-progress'`.
    const text = parts?.find((p) => p.type === 'text') as { text?: unknown } | undefined;
    return { ...meta, ...(typeof text?.text === 'string' && text.text ? { contents: text.text } : {}) };
  }
  if ((message as { type?: unknown }).type === 'task-progress') {
    const text = parts?.find((p) => p.type === 'text') as { text?: unknown } | undefined;
    const attrs = (message as { attributes?: unknown }).attributes;
    return { tagName: 'task-progress', type: 'task-progress', ...(typeof text?.text === 'string' ? { contents: text.text } : {}), ...(attrs ? { attributes: attrs } : {}) };
  }
  return null;
}

/**
 * TB-363 (MUST-2): true when a stored row IS a task-progress signal row (real Mastra 1.81
 * shape: role 'signal' + a plain TEXT part + content.metadata.signal.tagName 'task-progress';
 * older rows may carry a data-signal part instead). Such a row is the runner/tool fan-out's
 * NOTICE — never a fake user turn. Shared by the history renderer and the live SSE path.
 */
export function isTaskProgressSignalRow(message: { role?: unknown; content?: unknown; type?: unknown }): boolean {
  if (message.role !== 'signal') return false;
  if ((message as { type?: unknown }).type === 'task-progress') return true;
  const parts = partsOf(message.content);
  if (
    parts?.some(
      (p) =>
        p.type === 'data-signal' &&
        ((p.data as Record<string, unknown> | undefined)?.tagName ?? (p as Record<string, unknown>).tagName) === 'task-progress',
    )
  ) {
    return true;
  }
  const meta = (message.content as { metadata?: { signal?: Record<string, unknown> } } | null | undefined)?.metadata?.signal;
  return Boolean(meta && (meta.tagName ?? meta.type) === 'task-progress');
}

function taskProgressNoticeItem(message: StoredThreadMessage): AgentChatItem | null {
  if (message.role !== 'signal') return null;
  const bag = signalBag(message);
  if (!bag) return null;
  const attrs = (bag.attributes && typeof bag.attributes === 'object' ? bag.attributes : {}) as Record<string, unknown>;
  const stage = typeof attrs.stage === 'string' && attrs.stage ? attrs.stage : typeof bag.type === 'string' ? bag.type : 'update';
  const title = typeof attrs.title === 'string' && attrs.title ? attrs.title : undefined;
  const rawContents = typeof bag.contents === 'string' ? bag.contents : '';
  const label =
    stage === 'waiting_on_user'
      ? 'Waiting on you'
      : stage === 'failed'
        ? 'Failed'
        : stage === 'done'
          ? 'Done'
          : stage === 'started'
            ? 'Started'
            : stage === 'needs_review'
              ? 'Needs another look'
              : stage;
  const text = rawContents.trim() || `Task ${label}${title ? `: "${title}"` : ''}.`;
  const taskId = typeof attrs.taskId === 'string' ? attrs.taskId : undefined;
  const runId = typeof attrs.runId === 'string' ? attrs.runId : undefined;
  return {
    kind: 'notice',
    id: `${message.id}:notice`,
    noticeKind: 'task-progress',
    stage,
    text,
    ...(taskId ? { taskId } : {}),
    ...(runId ? { runId } : {}),
  };
}

/**
 * Persisted thread messages (oldest first) → assistant chat items: user turns (dashboard context block
 * removed), assistant text, reasoning and tool calls. System / tool-role messages are not shown.
 * A tool call stored twice (call, then result) keeps one item with the latest state.
 *
 * DM-2: each item carries the message's `createdAt` as a display-only `at` (see chat-state.ts), so
 * the chat can position DM chips around it in the transcript.
 */
export function chatItemsFromStoredMessages(messages: readonly StoredThreadMessage[]): AgentChatItem[] {
  const items: AgentChatItem[] = [];
  const seen = new Map<string, number>();
  const push = (item: AgentChatItem, at: string | undefined) => {
    const key = `${item.kind}\u0000${item.id}`;
    const stamped: AgentChatItem =
      at !== undefined && !Number.isNaN(Date.parse(at)) ? { ...item, at } : item;
    const at2 = seen.get(key);
    if (at2 === undefined) {
      seen.set(key, items.length);
      items.push(stamped);
    } else if (stamped.kind === 'tool' && (stamped.status === 'done' || (items[at2] as { status?: string }).status !== 'done')) {
      items[at2] = stamped;
    }
  };
  for (const message of messages) {
    if (!message || typeof message.id !== 'string') continue;
    if (isUserTurn(message)) {
      // TB-363 (MUST-2): a task-progress signal row is the fan-out's NOTICE — it carries the
      // human line in a plain TEXT part, so the user-turn branch below would draw a fake
      // right-aligned user bubble for it and the notice would show TWICE (bubble + notice).
      // Such rows render ONLY as the notice item.
      const notice = taskProgressNoticeItem(message);
      if (notice) {
        push(notice, message.createdAt);
      } else {
        const text = stripDashboardContext(userText(message));
        if (text.trim()) push({ kind: 'user', id: message.id, text, mode: 'run', delivery: 'delivered' }, message.createdAt);
      }
    } else if (message.role === 'assistant') {
      for (const item of assistantItems(message)) push(item, message.createdAt);
    }
  }
  // TB-363 (S1 / contract M17): a needs-input ask stops being the CURRENT ask once the human
  // answered and the task RESUMED — a later `started` (pending→running) notice for the same
  // taskId. The superseded waiting_on_user notice is not presented. A done/failed without an
  // intervening resume does NOT resolve the ask (the contract scopes resolution to the resume).
  const progressedAt = new Map<string, number>();
  items.forEach((it, i) => {
    const n = it as { kind?: string; noticeKind?: string; stage?: string; taskId?: string };
    if (n.kind === 'notice' && n.noticeKind === 'task-progress' && n.taskId && n.stage === 'started') {
      progressedAt.set(n.taskId, i);
    }
  });
  const resolved = items.filter((it, i) => {
    const n = it as { kind?: string; noticeKind?: string; stage?: string; taskId?: string };
    return !(n.kind === 'notice' && n.noticeKind === 'task-progress' && n.stage === 'waiting_on_user'
      && n.taskId && (progressedAt.get(n.taskId) ?? -1) > i);
  });
  return resolved;
}

export interface ThreadHistoryPage {
  /** Oldest first. */
  messages: StoredThreadMessage[];
  /** Older messages exist before this page (show "Load previous"). */
  hasMore: boolean;
}

/**
 * CHAT-PAGE-1: one page of the thread's persisted messages, bypassing any HTTP cache: without
 * `before` the newest `limit`, with `before` (a stored message id) the `limit` messages before it.
 * Without `limit` and `before` the whole transcript (`hasMore: false`).
 */
export async function fetchThreadHistoryPage(opts: {
  agentId: string;
  threadId: string;
  limit?: number;
  before?: string | null;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ThreadHistoryPage> {
  const f = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  if (!isUsableAguiId(opts.agentId)) throw new AguiThreadBootstrapError('Agent not found', 404);
  if (!isUsableAguiId(opts.threadId)) throw new AguiThreadBootstrapError('Thread not found', 404);
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', opts.before);
  const qs = params.toString();
  const url = `/api/assistant/agents/${encodeURIComponent(opts.agentId)}/threads/${encodeURIComponent(opts.threadId)}/messages${qs ? `?${qs}` : ''}`;
  const res = await f(url, { method: 'GET', cache: 'no-store', signal: opts.signal });
  let body: { messages?: unknown; hasMore?: unknown; error?: unknown } = {};
  try {
    body = ((await res.json()) as typeof body) ?? {};
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    throw new AguiThreadBootstrapError(typeof body.error === 'string' && body.error ? body.error : 'Could not load this chat', res.status);
  }
  return {
    messages: Array.isArray(body.messages) ? (body.messages as StoredThreadMessage[]) : [],
    hasMore: body.hasMore === true,
  };
}

/**
 * Fetches every persisted message of the agent's thread, bypassing any HTTP cache, so each time the
 * chat opens it shows the conversation as it is now. (CHAT-PAGE-1: the chat loads pages with
 * fetchThreadHistoryPage; this full read remains for other callers.)
 */
export async function fetchThreadHistory(opts: {
  agentId: string;
  threadId: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<StoredThreadMessage[]> {
  return (await fetchThreadHistoryPage(opts)).messages;
}
