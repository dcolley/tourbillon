import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPriority, isCheckedOutNotice } from './priority';

const base = { authorType: 'agent', authorName: 'CTO', isNewest: false, agentName: 'Cyber', agentUrlKey: 'cyber' };

describe('WC3 classifyPriority', () => {
  it('user/Board author is P1', () => {
    assert.equal(classifyPriority({ ...base, authorType: 'user', authorName: 'Board', body: 'ok' }), 1);
  });
  it('"Board answered … APPROVED" body is P1', () => {
    assert.equal(classifyPriority({ ...base, body: 'Board answered 686ede6c (APPROVED, option i).' }), 1);
    assert.equal(classifyPriority({ ...base, body: 'Board ruling: descope.' }), 1);
    assert.equal(classifyPriority({ ...base, body: '23a36ba8 was REJECTED' }), 1);
  });
  it('a plain agent status note is P2', () => {
    assert.equal(classifyPriority({ ...base, body: 'Parked: still pending on approval; approved-ish wording in lower case.' }), 2);
  });
  it('the newest comment is P1', () => {
    assert.equal(classifyPriority({ ...base, isNewest: true, body: 'plain' }), 1);
  });
  it('another author mentioning the agent by name or @urlKey is P1; the agent itself is not', () => {
    assert.equal(classifyPriority({ ...base, body: 'Cyber, please re-check.' }), 1);
    assert.equal(classifyPriority({ ...base, body: 'ping @cyber' }), 1);
    assert.equal(classifyPriority({ ...base, body: 'Cyberspace is unrelated' }), 2);
    assert.equal(classifyPriority({ ...base, authorName: 'Cyber', body: 'Cyber here, still parked' }), 2);
  });
});

describe('WC3 isCheckedOutNotice', () => {
  it('matches the whole-body notice only', () => {
    assert.ok(isCheckedOutNotice('⏳ Checked out issue.'));
    assert.ok(isCheckedOutNotice('Checked out issue'));
    assert.ok(!isCheckedOutNotice('Checked out issue. Then I found a bug in the matcher.'));
  });
});
