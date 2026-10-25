/** DM-1: grouping and strip summary for an agent's DMs. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentDmsUrl, dmDirection, dmStripLabel, dmStripSummary, groupDmsByPeer, type AgentDm } from './agent-dms';

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
    const s = dmStripSummary(groupDmsByPeer(mails, ceo.id), 2)!;
    assert.deepEqual(s, { count: 4, peers: ['QA', 'PM'], morePeers: 1 });
    assert.equal(dmStripLabel(s), '4 DMs with QA, PM +1');
    assert.equal(dmStripLabel({ count: 1, peers: ['CTO'], morePeers: 0 }), '1 DM with CTO');
    assert.equal(dmStripLabel({ count: 100, peers: ['CTO'], morePeers: 0 }), '100+ DMs with CTO');
  });
});
