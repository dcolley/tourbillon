import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL_ACTORS, approvalActivityScrubber, approvalCreatedActivity, approvalDecidedActivity } from './approval-activity';

const approval = { id: 'appr-a', companyId: 'company-a', type: 'hire_agent', issueIds: ['i1'], payload: { title: ' T ', summary: '  ' } };

describe('approval lifecycle activity rows', () => {
  it('created: entity is the approval, company copied, blank summary → note null', () => {
    const row = approvalCreatedActivity({ approval, actor: { type: 'agent', id: 'agent-a', name: 'Alice' } });
    assert.equal(row.action, 'approval.created');
    assert.deepEqual([row.entityType, row.entityId, row.companyId], ['approval', 'appr-a', 'company-a']);
    assert.deepEqual([row.actorType, row.actorId, row.actorName], ['agent', 'agent-a', 'Alice']);
    assert.deepEqual(row.details, { approvalId: 'appr-a', type: 'hire_agent', status: 'pending', title: 'T', note: null, issueIds: ['i1'] });
  });

  it('null-safe actor and payload', () => {
    const row = approvalCreatedActivity({ approval: { ...approval, payload: null, issueIds: null }, actor: null });
    assert.deepEqual([row.actorType, row.actorId, row.actorName], ['system', 'unknown', null]);
    assert.deepEqual((row.details as Record<string, unknown>).issueIds, []);
  });

  it('decided: decision and note; path actors', () => {
    const row = approvalDecidedActivity({ approval, decision: 'rejected', note: ' no ', actor: APPROVAL_ACTORS.hitly });
    assert.equal(row.action, 'approval.decided');
    assert.deepEqual([row.actorType, row.actorId, row.actorName], ['system', 'hitly', 'HITLy']);
    assert.deepEqual(row.details, { approvalId: 'appr-a', type: 'hire_agent', decision: 'rejected', status: 'rejected', note: 'no', issueIds: ['i1'] });
    assert.equal(approvalDecidedActivity({ approval, decision: 'approved', note: undefined, actor: APPROVAL_ACTORS.board }).actorName, 'Board');
    assert.equal(approvalDecidedActivity({ approval, decision: 'approved', note: null, actor: APPROVAL_ACTORS.mcp }).actorId, 'mcp');
  });

  describe('stored text never copies a resume token or secret (#130 scrubber)', () => {
    const RESUME = 'dummy-resume-token-0123456789';
    const KEY = 'dummy-nested-api-key-9876543210';
    const secretApproval = {
      ...approval,
      payload: {
        title: `Deploy (resume ${RESUME})`,
        summary: `Use apiKey=dummyinlinekey12345 and Authorization: Bearer dummybearer12345678 via https://h.example.test/cb?token=dummyurltoken1234 with ${KEY}`,
        hitlyResumeToken: RESUME,
        config: { nested: { apiKey: KEY } },
      },
    };
    const leaks = (row: unknown) =>
      [RESUME, KEY, 'dummyinlinekey12345', 'dummybearer12345678', 'dummyurltoken1234'].filter((v) => JSON.stringify(row).includes(v));

    it('created: title and summary note scrubbed; no payload secret copied into details', () => {
      const row = approvalCreatedActivity({ approval: secretApproval, actor: { type: 'agent', id: 'agent-a', name: 'Alice' } });
      assert.deepEqual(leaks(row), []);
      const d = row.details as Record<string, unknown>;
      assert.equal(d.title, 'Deploy (resume [redacted])');
      assert.match(String(d.note), /^Use apiKey=\[redacted\] and Authorization: Bearer \[redacted\] via https:\/\/h\.example\.test\/cb with \[redacted\]$/);
      assert.deepEqual(Object.keys(d).sort(), ['approvalId', 'issueIds', 'note', 'status', 'title', 'type']);
    });

    it('decided: a note echoing the resume token or a credential is scrubbed (all paths)', () => {
      for (const actor of [APPROVAL_ACTORS.board, APPROVAL_ACTORS.mcp, APPROVAL_ACTORS.hitly]) {
        const row = approvalDecidedActivity({
          approval: secretApproval,
          decision: 'rejected',
          note: ` resume=${RESUME}; key ${KEY}; Bearer dummybearer12345678 `,
          actor,
        });
        assert.deepEqual(leaks(row), []);
        assert.equal((row.details as Record<string, unknown>).note, 'resume=[redacted]; key [redacted]; Bearer [redacted]');
      }
    });

    it('scrubber: blank → null, plain text unchanged', () => {
      const scrub = approvalActivityScrubber(secretApproval.payload);
      assert.equal(scrub('   '), null);
      assert.equal(scrub(undefined), null);
      assert.equal(scrub(' Split the migration '), 'Split the migration');
    });
  });
});
