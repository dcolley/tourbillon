/**
 * UI-2b: assistant view routes. Canonical URLs use the agent's url key (its company-unique slug,
 * derived from the name at creation and unchanged when the agent is renamed):
 *   /assistant/<agent-url-key>              agent selected
 *   /assistant/<agent-url-key>/<threadId>   thread open
 * Older links — `/assistant?agent=<key|id>&thread=<id>` and `/assistant/<agent-id>[/<threadId>]` —
 * redirect to the canonical path. An agent that is missing or belongs to another company gets
 * the same not-found result, so links never reveal whether an agent exists elsewhere.
 * Pure: the server lookup lives in route-server.ts.
 */
import { assistantAgentPath } from './sidebar';

export interface AssistantRouteAgent {
  id: string;
  urlKey: string;
}

export type AssistantRouteDecision =
  | { kind: 'render'; agent: AssistantRouteAgent; threadId: string | null }
  | { kind: 'redirect'; location: string }
  | { kind: 'not-found' };

/** Longest agent key or thread id accepted from a URL (ids and url keys are far shorter). */
const MAX_SEGMENT = 200;
const UNSAFE_SEGMENT = /[\u0000-\u001F\u007F-\u009F/\\]/;

/** A URL segment or query value usable as an agent key / thread id, else null. */
export function cleanRouteSegment(value: string | string[] | undefined | null): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  // Dot-only values (`.`, `..`) would change the path once a URL is normalised (same rule as AGUI-1b).
  if (!s || s.length > MAX_SEGMENT || UNSAFE_SEGMENT.test(s) || /^\.+$/.test(s)) return null;
  return s;
}

/**
 * Decide what a request for the assistant view does, given the agent found for `requestedKey`
 * in the caller's company (null when there is none, whatever the reason).
 */
export function decideAssistantRoute(input: {
  agent: AssistantRouteAgent | null;
  requestedKey: string;
  threadId: string | null;
  /** `query` for `/assistant?agent=…`, `path` for `/assistant/<key>[/<thread>]`. */
  via: 'path' | 'query';
  /** A thread segment/param was present but unusable. */
  badThread?: boolean;
}): AssistantRouteDecision {
  if (!input.agent || input.badThread) return { kind: 'not-found' };
  if (input.via === 'query' || input.requestedKey !== input.agent.urlKey) {
    return { kind: 'redirect', location: assistantAgentPath(input.agent.urlKey, input.threadId) };
  }
  return { kind: 'render', agent: input.agent, threadId: input.threadId };
}

/** Selection from an assistant pathname (client side), e.g. `/assistant/ceo/t1` → {agent: 'ceo', thread: 't1'}. */
export function parseAssistantPath(pathname: string | null | undefined): { agent: string | null; thread: string | null } {
  const m = /^\/assistant\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname ?? '');
  if (!m) return { agent: null, thread: null };
  const decode = (s: string | undefined) => {
    if (s === undefined) return null;
    try {
      return cleanRouteSegment(decodeURIComponent(s));
    } catch {
      return null;
    }
  };
  const agent = decode(m[1]);
  return { agent, thread: agent ? decode(m[2]) : null };
}
