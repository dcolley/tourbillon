/**
 * #130 B3: approval details when vault values can't be loaded (key unset, wrong key, corrupt
 * row). The real repo decrypts dummy vault rows; free text is hidden, everything else renders.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { approvalDetailJson, loadApprovalDetail } from './approval-detail';
import { REDACTION_UNAVAILABLE } from './approval-redaction';
import { PLANTED_VALUES, plantedRepo } from './approval-detail-secrets.fixture';
import {
  DUMMY_VAULT_KEY,
  OTHER_DUMMY_VAULT_KEY,
  VAULT_ONLY_VALUES,
  captureLogs,
  plantedSecretRows,
  vaultBackedRepo,
  withVaultKey,
} from './approval-detail-vault.fixture';

const H = REDACTION_UNAVAILABLE;
const forms = (v: string) => [v, encodeURIComponent(v), JSON.stringify(v).slice(1, -1)];
const leaks = (text: string) => PLANTED_VALUES.filter((v) => forms(v).some((f) => text.includes(f)));

describe('approval details: vault values available', () => {
  it('values decrypted by the repo are scrubbed; nothing hidden', async () => {
    const rows = await plantedSecretRows();
    const d = await withVaultKey(DUMMY_VAULT_KEY, () => loadApprovalDetail(vaultBackedRepo(rows), 'company-a', 'appr-a'));
    assert.ok(d);
    assert.equal(d.redactionUnavailable, false);
    assert.equal(d.approval.title, 'Deploy with [redacted]');
    assert.equal(d.linkedIssues[0].title, 'Rotate [redacted]');
    assert.deepEqual(d.relatedApprovals.map((r) => r.title), ['Use vault [redacted]', 'Retry with [redacted]']);
    assert.deepEqual(leaks(JSON.stringify(approvalDetailJson(d))), []);
    assert.deepEqual(leaks(JSON.stringify(d)), []);
  });
});

describe('approval details: vault values unavailable (#130 B3)', () => {
  const scenarios: Array<[string, string | null, boolean]> = [
    ['key unset', null, false],
    ['wrong key', OTHER_DUMMY_VAULT_KEY, false],
    ['corrupt row', DUMMY_VAULT_KEY, true],
  ];
  for (const [name, key, corrupt] of scenarios) {
    it(`${name}: free text hidden, status/dates/ids/actors kept, no vault value anywhere or in the log`, async () => {
      const rows = await plantedSecretRows({ corrupt });
      const { result: d, logs } = await captureLogs(() =>
        withVaultKey(key, () => loadApprovalDetail(vaultBackedRepo(rows), 'company-a', 'appr-a')),
      );
      assert.ok(d);
      assert.equal(d.redactionUnavailable, true);
      // Hidden: payload, title, summary, decision note, HITLy error, linked issue titles, notes.
      assert.equal(d.approval.payload, H);
      assert.equal(d.approval.payloadTruncated, false);
      assert.equal(d.approval.title, H);
      assert.equal(d.approval.summary, H);
      assert.equal(d.approval.note, H);
      assert.equal(d.approval.hitlyError, H);
      assert.deepEqual(d.linkedIssues.map((i) => i.title), [H]);
      assert.equal(d.history.find((e) => e.text === 'approval.commented')?.note, H);
      assert.equal(d.history.find((e) => e.kind === 'decided')?.note, H);
      assert.equal(d.history.find((e) => e.kind === 'hitly_error')?.text, `HITLy error: ${H}`);
      // #131: creation note, decision feedback and related approval titles are hidden too.
      assert.equal(d.history.find((e) => e.kind === 'created')?.note, H);
      assert.equal(d.history.find((e) => e.kind === 'decided')?.noteLabel, 'Board feedback');
      assert.deepEqual(
        d.relatedApprovals.map((r) => [r.id, r.status, r.title, r.sharedIssueIds]),
        [
          ['appr-r2', 'pending', H, ['issue-a1']],
          ['appr-r1', 'rejected', H, ['issue-a1']],
        ],
      );
      // Kept: status, dates, ids, actors, issue identifiers.
      assert.equal(d.approval.id, 'appr-a');
      assert.equal(d.approval.status, 'rejected');
      assert.equal(d.approval.type, 'request_board_approval');
      assert.equal(d.approval.hitlyApprovalId, 'hitly-1');
      assert.equal(d.approval.createdAt.toISOString(), '2026-10-08T09:00:00.000Z');
      assert.equal(d.approval.decidedAt?.toISOString(), '2026-10-08T10:30:00.000Z');
      assert.equal(d.requester?.name, 'Alice');
      assert.equal(d.decidedBy, 'Board');
      assert.deepEqual(d.linkedIssues.map((i) => [i.id, i.identifier, i.status]), [['issue-a1', 'TOUR-1', 'todo']]);
      assert.deepEqual(d.history.map((e) => e.kind), ['created', 'hitly_sent', 'hitly_error', 'issue_halted', 'activity', 'decided']);
      // Other sources (key names, actor scrub) still run.
      assert.equal(d.history.find((e) => e.text === 'approval.commented')?.actor, 'Board via [redacted]');
      // JSON body and the page's RSC props carry no planted value.
      const json = JSON.stringify(approvalDetailJson(d));
      assert.deepEqual(leaks(json), []);
      assert.match(json, /"redactionUnavailable":true/);
      assert.deepEqual(leaks(JSON.stringify(d)), []);
      // The log names rows and counts only.
      assert.match(logs, /vault values unavailable/);
      assert.deepEqual(leaks(logs), []);
      for (const r of rows.vault) assert.ok(!logs.includes(r.encryptedValue), 'ciphertext logged');
      for (const v of VAULT_ONLY_VALUES) assert.ok(!logs.includes(v));
    });
  }
});

describe('approval details: secret values load fails (#130 B3)', () => {
  it('query error: page-level loader hides free text (no throw), status/ids kept', async () => {
    const repo = {
      ...plantedRepo(),
      getSecretValues: async () => {
        throw new Error('db down');
      },
    };
    const { result: d, logs } = await captureLogs(() => loadApprovalDetail(repo, 'company-a', 'appr-a'));
    assert.ok(d);
    assert.equal(d.redactionUnavailable, true);
    assert.equal(d.approval.payload, H);
    assert.equal(d.approval.title, H);
    assert.equal(d.approval.id, 'appr-a');
    assert.equal(d.approval.status, 'rejected');
    assert.match(logs, /secret values unavailable/);
    assert.deepEqual(leaks(JSON.stringify(approvalDetailJson(d))), []);
  });
});
