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

/** Strip summary, or null when there is nothing to show (the strip stays hidden). */
export function dmStripSummary(conversations: readonly DmConversation[], maxPeers = 3): DmStripSummary | null {
  const count = conversations.reduce((n, c) => n + c.mails.length, 0);
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
