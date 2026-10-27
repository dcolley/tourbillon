/**
 * DM-1: an agent's DMs (A2A mail) as the assistant chat shows them, read-only. Data comes from the
 * board-session route GET /api/companies/[companyId]/agent-mail-client?agentId=&limit= (the same
 * source as the Control Pane Mail tab); code and API keep the `agent_mail` name, the UI says "DM".
 * Pure helpers: grouping by peer and the strip summary are computed on the client.
 */

export interface DmAgentRef {
  id: string;
  name: string;
  urlKey: string;
}

/** One row of GET agent-mail-client (`mails[]`). */
export interface AgentDm {
  id: string;
  companyId: string;
  fromAgentId: string;
  toAgentId: string;
  body: string;
  inReplyTo: string | null;
  createdAt: string;
  fromAgent?: DmAgentRef;
  toAgent?: DmAgentRef;
}

export interface AgentDmsResponse {
  mails: AgentDm[];
}

/** Most rows the route returns (it caps `limit` at 100). */
export const AGENT_DMS_LIMIT = 100;

/** The board-session read for one agent's sent and received DMs. */
export function agentDmsUrl(companyId: string, agentId: string, limit: number = AGENT_DMS_LIMIT): string {
  const q = new URLSearchParams({ agentId, limit: String(limit) });
  return `/api/companies/${encodeURIComponent(companyId)}/agent-mail-client?${q.toString()}`;
}

/** `to` when `agentId` sent the DM, else `from`. */
export function dmDirection(mail: Pick<AgentDm, 'fromAgentId'>, agentId: string): 'to' | 'from' {
  return mail.fromAgentId === agentId ? 'to' : 'from';
}

/** The other agent of a DM, seen from `agentId` (the agent itself for a DM to itself). */
export function dmPeer(mail: AgentDm, agentId: string): { id: string; name: string; urlKey?: string } {
  const sent = mail.fromAgentId === agentId;
  const id = sent ? mail.toAgentId : mail.fromAgentId;
  const ref = sent ? mail.toAgent : mail.fromAgent;
  return { id, name: ref?.name || 'Unknown agent', ...(ref?.urlKey ? { urlKey: ref.urlKey } : {}) };
}

export interface DmConversation {
  peerId: string;
  peerName: string;
  peerUrlKey?: string;
  /** Oldest first, as a conversation reads. */
  mails: AgentDm[];
  /** createdAt of the newest DM. */
  lastAt: string;
}

const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Group an agent's DMs by peer (the other of from / to). Conversations are ordered newest
 * activity first; DMs inside one oldest first. Ties keep the input order.
 */
export function groupDmsByPeer(mails: readonly AgentDm[], agentId: string): DmConversation[] {
  const byPeer = new Map<string, DmConversation>();
  for (const mail of mails) {
    const peer = dmPeer(mail, agentId);
    let conv = byPeer.get(peer.id);
    if (!conv) {
      conv = { peerId: peer.id, peerName: peer.name, ...(peer.urlKey ? { peerUrlKey: peer.urlKey } : {}), mails: [], lastAt: mail.createdAt };
      byPeer.set(peer.id, conv);
    } else if (conv.peerName === 'Unknown agent' && peer.name !== 'Unknown agent') {
      conv.peerName = peer.name;
      if (peer.urlKey) conv.peerUrlKey = peer.urlKey;
    }
    conv.mails.push(mail);
    if (time(mail.createdAt) > time(conv.lastAt)) conv.lastAt = mail.createdAt;
  }
  const out = [...byPeer.values()];
  for (const conv of out) {
    conv.mails = conv.mails
      .map((m, i) => [m, i] as const)
      .sort((a, b) => time(a[0].createdAt) - time(b[0].createdAt) || a[1] - b[1])
      .map(([m]) => m);
  }
  return out
    .map((c, i) => [c, i] as const)
    .sort((a, b) => time(b[0].lastAt) - time(a[0].lastAt) || a[1] - b[1])
    .map(([c]) => c);
}

export interface DmStripSummary {
  /** DMs loaded (the route's most recent, up to its limit). */
  count: number;
  /** Peers with the most recent activity, newest first. */
  peers: string[];
  /** Further peers not named. */
  morePeers: number;
}

/** Strip summary, or null when there is nothing to show (the strip stays hidden). Counts per pair
 * come from the DM-2 conversation view (`count`); the underlying grouping is shared with `groupDmsByPeer`. */
export function dmStripSummary(conversations: readonly DmConversationView[], maxPeers = 3): DmStripSummary | null {
  const count = conversations.reduce((n, c) => n + c.count, 0);
  if (count === 0) return null;
  const peers = conversations.slice(0, maxPeers).map((c) => c.peerName);
  return { count, peers, morePeers: Math.max(0, conversations.length - peers.length) };
}

/** e.g. `3 DMs with CEO, CTO +1` (the count is capped by the route limit). */
export function dmStripLabel(summary: DmStripSummary, limit: number = AGENT_DMS_LIMIT): string {
  const n = summary.count >= limit ? `${limit}+` : String(summary.count);
  const noun = summary.count === 1 ? 'DM' : 'DMs';
  const more = summary.morePeers > 0 ? ` +${summary.morePeers}` : '';
  return `${n} ${noun} with ${summary.peers.join(', ')}${more}`;
}

/* ------------------------------------------------------------------ *
 * DM-2: conversation picker (left list + right thread pane) and the
 * transcript chips. All of this is client-side display only: nothing here
 * changes what the agent sends, or what is sent to the model as context.
 * ------------------------------------------------------------------ */

/** One durable agent-pair conversation, as the conversation picker shows it. */
export interface DmConversationView {
  peerId: string;
  peerName: string;
  peerUrlKey?: string;
  /** Oldest first, as a conversation reads. */
  messages: AgentDm[];
  /** createdAt of the newest DM of the pair. */
  lastAt: string;
  /** How many of the loaded DMs belong to the pair. */
  count: number;
}

/**
 * DM-2: group an agent's DMs into conversations (the durable agent pair), newest activity
 * first, messages oldest first inside. Same grouping as `groupDmsByPeer`, shaped for the
 * conversation picker: the modal keys a conversation by `peerId`, never by a short-lived channel.
 */
export function buildConversations(dms: readonly AgentDm[], selfAgentId: string): DmConversationView[] {
  return groupDmsByPeer(dms, selfAgentId).map((conv) => ({
    peerId: conv.peerId,
    peerName: conv.peerName,
    ...(conv.peerUrlKey ? { peerUrlKey: conv.peerUrlKey } : {}),
    messages: conv.mails,
    lastAt: conv.lastAt,
    count: conv.mails.length,
  }));
}

/** One-line snippet of a DM body (chips and conversation rows). */
export function dmSnippet(body: string, max = 80): string {
  const one = body.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** `Messaged <Peer>` for outbound, `Message from <Peer>` for inbound, seen from `agentId`. */
export function dmChipText(mail: AgentDm, agentId: string): string {
  const peer = dmPeer(mail, agentId);
  return mail.fromAgentId === agentId ? `Messaged ${peer.name}` : `Message from ${peer.name}`;
}

/** Coarse relative time for the conversation list ("now", "5m", "3h", "2d", then `YYYY-MM-DD`). */
export function dmRelativeTime(iso: string, now: number = Date.now()): string {
  const t = time(iso);
  if (!t) return '';
  const minutes = Math.floor(Math.max(0, now - t) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(t).toISOString().slice(0, 10);
}

/** The localStorage key holding the last-seen time (ms) of one agent+peer pair (client-only unread). */
export function dmLastSeenKey(agentId: string, peerId: string): string {
  return `dm-last-seen:${agentId}:${peerId}`;
}

/** The part of `Storage` this file uses (a `Map` passes in tests). */
export interface DmStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const windowStorage = (): DmStorageLike | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** The last-seen times (ms since epoch, 0 = never) of the given peers. A bad entry reads as never-seen. */
export function readDmLastSeen(
  storage: DmStorageLike | null | undefined,
  agentId: string,
  peerIds: readonly string[],
): Record<string, number> {
  const s = storage === undefined ? windowStorage() : storage;
  const out: Record<string, number> = {};
  for (const peerId of peerIds) {
    let value = 0;
    try {
      const raw = s?.getItem(dmLastSeenKey(agentId, peerId));
      const parsed = raw === null || raw === undefined ? Number.NaN : Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) value = parsed;
    } catch {
      /* private mode / disabled storage: treat as never-seen */
    }
    out[peerId] = value;
  }
  return out;
}

/** Mark one conversation as read (client-only; never throws). */
export function markDmSeen(storage: DmStorageLike | null | undefined, agentId: string, peerId: string, at: number = Date.now()): void {
  const s = storage === undefined ? windowStorage() : storage;
  try {
    s?.setItem(dmLastSeenKey(agentId, peerId), String(at));
  } catch {
    /* private mode / disabled storage: unread state stays client-best-effort */
  }
}

/** The peers whose conversation has a message newer than its last-seen time (unread dots).
 * `hidePeers` (the pair on screen in the modal) is never flagged unread — its body is being read. */
export function unreadPeerIds(
  conversations: readonly DmConversationView[],
  lastSeen: Record<string, number>,
  hidePeers: readonly string[] = [],
): string[] {
  return conversations
    .filter((conv) => !hidePeers.includes(conv.peerId) && time(conv.lastAt) > (lastSeen[conv.peerId] ?? 0))
    .map((conv) => conv.peerId);
}

/** A transcript entry as the timeline merge sees it: the `at` stamp is display-only. */
export interface TimelineItemLike {
  kind: string;
  id: string;
  /** The time the client knows for this message (stored `createdAt`, or when it arrived). Display only. */
  at?: string;
}

/** One row of the rendered transcript: a chat item (kept in its full type), or a DM shown as a chip. */
export type DmTimelineRow<T extends TimelineItemLike = TimelineItemLike> =
  | { key: string; kind: 'item'; item: T }
  | { key: string; kind: 'dm'; mail: AgentDm };

const atMs = (iso?: string): number => {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? Number.NaN : t;
};

/**
 * DM-2: the DMs that become transcript chips — only DMs after the current Assistant thread
 * start (`threadStartedAt`; without it, every loaded DM), in chronological order. Keys and order
 * are stable across polls, so chips never flicker; chips are display-only and never reach the
 * model as chat context.
 */
export function dmTranscriptChips(
  dms: readonly AgentDm[],
  opts: { threadStartedAt?: number | null } = {},
): AgentDm[] {
  const start = opts.threadStartedAt;
  const kept =
    start === null || start === undefined
      ? [...dms]
      : dms.filter((mail) => {
          const t = atMs(mail.createdAt);
          return !Number.isNaN(t) && t >= start;
        });
  return kept
    .map((mail, i) => [mail, i] as const)
    .sort((a, b) => atMs(a[0].createdAt) - atMs(b[0].createdAt) || a[1] - b[1])
    .map(([mail]) => mail);
}

/**
 * DM-2: merge the DM chips into the transcript rows by timestamp. An item's place in time is its
 * own `at`, or (messages that arrive without a timestamp — tool calls, reasoning, a re-attached
 * run) the time of the next message that has one, since a run continues the turn it sits in;
 * with no timestamp behind it, the time is `now` (an open run is happening now). A chip goes
 * directly after the last message older than it; chips newer than everything trail the
 * transcript, oldest first. Same inputs, same rows: stable keys across polls.
 */
export function mergeDmTranscriptTimeline<T extends TimelineItemLike>(
  items: readonly T[],
  chips: readonly AgentDm[],
  opts: { now?: number } = {},
): DmTimelineRow<T>[] {
  const rows: DmTimelineRow<T>[] = [];
  if (chips.length === 0) {
    for (const item of items) rows.push({ key: `${item.kind}:${item.id}`, kind: 'item', item: item });
    return rows;
  }
  const times: number[] = new Array<number>(items.length);
  let carry = Number.NaN;
  for (let i = items.length - 1; i >= 0; i--) {
    const t = atMs(items[i].at);
    carry = Number.isNaN(t) ? carry : t;
    times[i] = carry;
  }
  const now = opts.now ?? Date.now();
  let pending = [...chips];
  for (let i = 0; i < items.length; i++) {
    const t = Number.isNaN(times[i]) ? now : times[i];
    while (pending.length > 0 && atMs(pending[0].createdAt) <= t) {
      const mail = pending[0];
      rows.push({ key: `dm:${mail.id}`, kind: 'dm', mail });
      pending = pending.slice(1);
    }
    rows.push({ key: `${items[i].kind}:${items[i].id}`, kind: 'item', item: items[i] });
  }
  for (const mail of pending) rows.push({ key: `dm:${mail.id}`, kind: 'dm', mail });
  return rows;
}
