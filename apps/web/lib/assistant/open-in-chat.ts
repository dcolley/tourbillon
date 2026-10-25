/**
 * UI-3: "Open in chat" links from Control Pane pages to the page's default agent in the assistant view:
 *   /assistant/<agent-url-key>?context=<type>:<id>[&contextTitle=<title>]
 * The assistant page reads the context back (parseOpenInChatContext); the composer shows it as a
 * removable chip and sends it with the first message (the endpoint wraps it for the model, see
 * lib/chat/dashboard-context.ts). Pure: no React, no Next.
 */
import { cleanRouteSegment } from './route';
import { assistantAgentPath } from './sidebar';

/** Page context types a Control Pane page can open the chat with (a subset of the chat context types). */
export const OPEN_IN_CHAT_CONTEXT_TYPES = ['issue', 'project', 'goal', 'heartbeat', 'agent', 'board'] as const;

export type OpenInChatContextType = (typeof OPEN_IN_CHAT_CONTEXT_TYPES)[number];

export interface OpenInChatContext {
  contextType: OpenInChatContextType;
  contextId: string;
  contextTitle?: string;
}

/** Longest title carried in the link (and shown in the chip). */
export const OPEN_IN_CHAT_TITLE_MAX = 200;

const CONTEXT_TYPE_LABELS: Record<OpenInChatContextType, string> = {
  issue: 'Issue',
  project: 'Project',
  goal: 'Goal',
  heartbeat: 'Heartbeat',
  agent: 'Agent',
  board: 'Issue board',
};

export function isOpenInChatContextType(value: unknown): value is OpenInChatContextType {
  return typeof value === 'string' && (OPEN_IN_CHAT_CONTEXT_TYPES as readonly string[]).includes(value);
}

function first(value: string | string[] | undefined | null): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' ? v : undefined;
}

/** Title without control characters, collapsed whitespace, at most OPEN_IN_CHAT_TITLE_MAX chars; else undefined. */
export function cleanContextTitle(value: string | string[] | undefined | null): string | undefined {
  const v = first(value);
  if (v === undefined) return undefined;
  const s = v.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > OPEN_IN_CHAT_TITLE_MAX ? `${s.slice(0, OPEN_IN_CHAT_TITLE_MAX - 1)}…` : s;
}

/**
 * Link to the agent's chat with the page context, or null when there is no usable agent url key
 * (the page has no default agent: no button). Without a usable context the link opens the agent's
 * chat only.
 */
export function openInChatHref(input: {
  agentUrlKey?: string | null;
  contextType?: string | null;
  contextId?: string | null;
  contextTitle?: string | null;
}): string | null {
  const key = cleanRouteSegment(input.agentUrlKey);
  if (!key) return null;
  const base = assistantAgentPath(key);
  const id = cleanRouteSegment(input.contextId);
  if (!isOpenInChatContextType(input.contextType) || !id) return base;
  const params = new URLSearchParams();
  params.set('context', `${input.contextType}:${id}`);
  const title = cleanContextTitle(input.contextTitle);
  if (title) params.set('contextTitle', title);
  return `${base}?${params.toString()}`;
}

/** The context from an assistant page's search params, or null when missing or not usable. */
export function parseOpenInChatContext(params: {
  context?: string | string[];
  contextTitle?: string | string[];
} | null | undefined): OpenInChatContext | null {
  const raw = first(params?.context);
  if (!raw) return null;
  const sep = raw.indexOf(':');
  if (sep <= 0) return null;
  const type = raw.slice(0, sep);
  const id = cleanRouteSegment(raw.slice(sep + 1));
  if (!isOpenInChatContextType(type) || !id) return null;
  const title = cleanContextTitle(params?.contextTitle);
  return title ? { contextType: type, contextId: id, contextTitle: title } : { contextType: type, contextId: id };
}

/** Chip text, e.g. `Issue: Fix login` (no title: `Issue 1a2b3c4d`; the board has no id to show). */
export function contextChipLabel(context: OpenInChatContext): string {
  const type = CONTEXT_TYPE_LABELS[context.contextType] ?? context.contextType;
  if (context.contextTitle) return `${type}: ${context.contextTitle}`;
  if (context.contextType === 'board') return type;
  return `${type} ${context.contextId.slice(0, 8)}`;
}
