import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL_ACTORS, approvalCreatedActivity, approvalDecidedActivity } from './approval-activity';

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
});
