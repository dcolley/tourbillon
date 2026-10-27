/** DM-1: grouping and strip summary for an agent's DMs. DM-2: the conversation view, chips and timeline merge. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentDmsUrl,
  buildConversations,
  dmChipText,
  dmDirection,
  dmRelativeTime,
  dmSnippet,
  dmStripLabel,
  dmStripSummary,
  dmTranscriptChips,
  groupDmsByPeer,
  markDmSeen,
  readDmLastSeen,
  mergeDmTranscriptTimeline,
  unreadPeerIds,
  type AgentDm,
} from './agent-dms';

const ceo = { id: 'a-ceo', name: 'CEO', urlKey: 'ceo' };
const cto = { id: 'a-cto', name: 'CTO', urlKey: 'cto' };
const pm = { id: 'a-pm', name: 'PM', urlKey: 'pm' };
const qa = { id: 'a-qa', name: 'QA', urlKey: 'qa' };
const refs = { [ceo.id]: ceo, [cto.id]: cto, [pm.id]: pm, [qa.id]: qa } as Record<string, typeof ceo>;

function dm(id: string, from: string, to: string, createdAt: string, extra: Partial<AgentDm> = {}): AgentDm {
  return {
    id,
    companyId: 'c1',
    fromAgentId: from,
    toAgentId: to,
    body: `body ${id}`,
    inReplyTo: null,
    createdAt,
    fromAgent: refs[from],
    toAgent: refs[to],
    ...extra,
  };
}

function mapStore(entries: Map<string, string> = new Map()) {
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}

describe('DM-1 agent DMs', () => {
  it('builds the board-session URL with agentId and limit', () => {
    assert.equal(agentDmsUrl('c 1', 'a-ceo'), '/api/companies/c%201/agent-mail-client?agentId=a-ceo&limit=100');
    assert.equal(agentDmsUrl('c1', 'a&b', 10), '/api/companies/c1/agent-mail-client?agentId=a%26b&limit=10');
  });

  it('direction: To when the agent sent it, From when it received it', () => {
    assert.equal(dmDirection(dm('1', ceo.id, cto.id, '2026-10-25T10:00:00Z'), ceo.id), 'to');
    assert.equal(dmDirection(dm('1', cto.id, ceo.id, '2026-10-25T10:00:00Z'), ceo.id), 'from');
  });

  it('groups sent and received DMs by the other agent, newest conversation first, oldest DM first inside', () => {
    // As the route returns them: newest first.
    const mails = [
      dm('4', pm.id, ceo.id, '2026-10-25T10:04:00Z'),
      dm('3', ceo.id, cto.id, '2026-10-25T10:03:00Z', { inReplyTo: '2' }),
      dm('2', cto.id, ceo.id, '2026-10-25T10:02:00Z'),
      dm('1', ceo.id, pm.id, '2026-10-25T10:01:00Z'),
      dm('0', ceo.id, cto.id, '2026-10-25T10:00:00Z'),
    ];
    const groups = groupDmsByPeer(mails, ceo.id);
    assert.deepEqual(
      groups.map((g) => [g.peerId, g.peerName, g.lastAt, g.mails.map((m) => m.id)]),
      [
        [pm.id, 'PM', '2026-10-25T10:04:00Z', ['1', '4']],
        [cto.id, 'CTO', '2026-10-25T10:03:00Z', ['0', '2', '3']],
      ],
    );
    assert.equal(groups[0].peerUrlKey, 'pm');
  });

  it('names an unknown peer and takes its name from a later row when one has it', () => {
    const groups = groupDmsByPeer(
      [
        dm('2', 'gone', ceo.id, '2026-10-25T10:02:00Z', { fromAgent: undefined }),
        dm('1', ceo.id, 'gone', '2026-10-25T10:01:00Z', { toAgent: { id: 'gone', name: 'Old bot', urlKey: 'old' } }),
      ],
      ceo.id,
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0].peerName, 'Old bot');
  });

  it('a DM to itself is one conversation with itself', () => {
    const groups = groupDmsByPeer([dm('1', ceo.id, ceo.id, '2026-10-25T10:00:00Z')], ceo.id);
    assert.deepEqual(groups.map((g) => [g.peerId, g.mails.length]), [[ceo.id, 1]]);
  });

  it('empty: no conversations and no strip summary', () => {
    assert.deepEqual(groupDmsByPeer([], ceo.id), []);
    assert.equal(dmStripSummary([]), null);
  });

  it('summary names the most recent peers and counts the rest', () => {
    const mails = [
      dm('4', qa.id, ceo.id, '2026-10-25T10:04:00Z'),
      dm('3', ceo.id, pm.id, '2026-10-25T10:03:00Z'),
      dm('2', cto.id, ceo.id, '2026-10-25T10:02:00Z'),
      dm('1', ceo.id, cto.id, '2026-10-25T10:01:00Z'),
    ];
    const s = dmStripSummary(buildConversations(mails, ceo.id), 2)!;
    assert.deepEqual(s, { count: 4, peers: ['QA', 'PM'], morePeers: 1 });
    assert.equal(dmStripLabel(s), '4 DMs with QA, PM +1');
    assert.equal(dmStripLabel({ count: 1, peers: ['CTO'], morePeers: 0 }), '1 DM with CTO');
    assert.equal(dmStripLabel({ count: 100, peers: ['CTO'], morePeers: 0 }), '100+ DMs with CTO');
  });
});

describe('DM-2 conversation view', () => {
  const mails = [
    dm('4', pm.id, ceo.id, '2026-10-25T10:04:00Z'),
    dm('3', ceo.id, cto.id, '2026-10-25T10:03:00Z', { inReplyTo: '2' }),
    dm('2', cto.id, ceo.id, '2026-10-25T10:02:00Z'),
    dm('1', ceo.id, pm.id, '2026-10-25T10:01:00Z'),
    dm('0', ceo.id, cto.id, '2026-10-25T10:00:00Z'),
  ];

  it('one durable conversation per agent pair: sent and received DMs together, with a count', () => {
    const convs = buildConversations(mails, ceo.id);
    assert.deepEqual(
      convs.map((c) => [c.peerId, c.count, c.messages.map((m) => m.id)]),
      [
        [pm.id, 2, ['1', '4']],
        [cto.id, 3, ['0', '2', '3']],
      ],
    );
    // Newest conversation activity first, oldest message first inside.
    assert.deepEqual(convs.map((c) => c.lastAt), ['2026-10-25T10:04:00Z', '2026-10-25T10:03:00Z']);
    // A peer with no DMs has no conversation (the pair, not a channel, is the conversation).
    assert.deepEqual(buildConversations([], ceo.id), []);
  });

  it('chip text reads from this agent: Messaged <Peer> out, Message from <Peer> in', () => {
    assert.equal(dmChipText(dm('1', ceo.id, cto.id, '2026-10-25T10:00:00Z'), ceo.id), 'Messaged CTO');
    assert.equal(dmChipText(dm('1', cto.id, ceo.id, '2026-10-25T10:00:00Z'), ceo.id), 'Message from CTO');
    assert.equal(dmSnippet('one\ntwo  three', 6), 'one t…');
    assert.equal(dmRelativeTime('2026-10-25T10:00:00Z', Date.parse('2026-10-25T10:00:30Z')), 'now');
  });

  it('chips keep only DMs at or after the thread start, oldest first', () => {
    const start = Date.parse('2026-10-25T10:02:30Z');
    const chips = dmTranscriptChips(mails, { threadStartedAt: start });
    assert.deepEqual(chips.map((m) => m.id), ['3', '4']);
    // Without a thread start everything loaded is chip-able (display only, never model context).
    assert.equal(dmTranscriptChips(mails, {}).length, mails.length);
  });

  it('the transcript merge places chips by time, stable keys, chips last when newest', () => {
    const items = [
      { kind: 'assistant' as const, id: 'a1', text: 'x', streaming: false, at: '2026-10-25T10:01:00Z' },
      // A run continues its turn: no own timestamp → it sits with the next message that has one.
      { kind: 'tool' as const, id: 't1', name: 'search', argsText: '', status: 'done' as const },
      { kind: 'assistant' as const, id: 'a2', text: 'y', streaming: false, at: '2026-10-25T10:05:00Z' },
    ];
    const chips = [dm('d1', cto.id, ceo.id, '2026-10-25T10:00:30Z'), dm('d2', ceo.id, cto.id, '2026-10-25T10:06:00Z')];
    const rows = mergeDmTranscriptTimeline(items, chips, { now: Date.parse('2026-10-25T10:07:00Z') });
    assert.deepEqual(
      rows.map((r) => r.kind === 'dm' ? `dm:${r.mail.id}` : `${r.item.kind}:${r.item.id}`),
      ['dm:d1', 'assistant:a1', 'tool:t1', 'assistant:a2', 'dm:d2'],
    );
    // Same inputs, same rows (keys stable across polls so chips never flicker).
    assert.deepEqual(mergeDmTranscriptTimeline(items, chips, { now: Date.parse('2026-10-25T10:07:00Z') }).map((r) => r.key), rows.map((r) => r.key));
    // No chips: the transcript is untouched.
    assert.deepEqual(mergeDmTranscriptTimeline(items, []).map((r) => r.kind), ['item', 'item', 'item']);
  });

  it('DM-2 (B1): the live tail interleaves with chips once stamped; an unstamped tail times as now', () => {
    const chip = dm('d1', cto.id, ceo.id, '2026-10-26T00:30:00Z');
    const now = Date.parse('2026-10-26T00:31:00Z');
    const keys = (rows: ReturnType<typeof mergeDmTranscriptTimeline>) =>
      rows.map((r) => (r.kind === 'dm' ? `dm:${r.mail.id}` : `${r.item.kind}:${r.item.id}`));
    // Unstamped live tail (Test's probe): nothing to place it by, so it times as `now` and the chip goes first.
    const unstamped = [
      { kind: 'user' as const, id: 'u1', text: 'hi', mode: 'run' as const, delivery: 'delivered' as const },
      { kind: 'assistant' as const, id: 'a1', text: 'hello', streaming: false },
    ];
    assert.deepEqual(keys(mergeDmTranscriptTimeline(unstamped, [chip], { now })), ['dm:d1', 'user:u1', 'assistant:a1']);
    // Live items stamped at creation (chat-state) interleave by time: before, between, after the chip.
    const live = [
      { ...unstamped[0], at: '2026-10-26T00:29:00Z' },
      { ...unstamped[1], at: '2026-10-26T00:29:30Z' },
      { kind: 'user' as const, id: 'u2', text: 'more', mode: 'run' as const, delivery: 'delivered' as const, at: '2026-10-26T00:30:40Z' },
      // still streaming / tool with no stamp sits with the next stamped message, else `now`
      { kind: 'tool' as const, id: 't1', name: 'search', argsText: '', status: 'running' as const },
    ];
    assert.deepEqual(keys(mergeDmTranscriptTimeline(live, [chip], { now })), ['user:u1', 'assistant:a1', 'dm:d1', 'user:u2', 'tool:t1']);
    // After Clear (empty transcript) a stamped live turn still sorts against the chip by time.
    const afterClear = [{ ...unstamped[0], at: '2026-10-26T00:30:50Z' }];
    assert.deepEqual(keys(mergeDmTranscriptTimeline(afterClear, [chip], { now })), ['dm:d1', 'user:u1']);
    const earlyAfterClear = [{ ...unstamped[0], at: '2026-10-26T00:20:00Z' }];
    assert.deepEqual(keys(mergeDmTranscriptTimeline(earlyAfterClear, [chip], { now })), ['user:u1', 'dm:d1']);
  });

  it('client-only unread: last-seen per pair, bad entries read as never-seen', () => {
    const convs = buildConversations(mails, ceo.id);
    const storage = mapStore();
    assert.deepEqual(unreadPeerIds(convs, readDmLastSeen(storage, ceo.id, convs.map((c) => c.peerId))), convs.map((c) => c.peerId));
    const conv = convs[0];
    markDmSeen(storage, ceo.id, conv.peerId, Date.parse('2026-10-25T11:00:00Z'));
    assert.deepEqual(unreadPeerIds(convs, readDmLastSeen(storage, ceo.id, convs.map((c) => c.peerId))), [convs[1].peerId]);
    storage.setItem('dm-last-seen:a-ceo:a-cto', 'garbage');
    assert.equal(readDmLastSeen(storage, ceo.id, [cto.id, pm.id])[cto.id], 0);
    // Broken storage never throws (unread dots stay best-effort).
    assert.deepEqual(readDmLastSeen(null, ceo.id, [cto.id]), { [cto.id]: 0 });
  });
});
