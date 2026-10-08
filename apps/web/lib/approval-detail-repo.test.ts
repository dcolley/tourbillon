/** SQL shape of the approval details repo (fake postgres client, no DB): every query is company-scoped. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createApprovalDetailRepo } from './approval-detail-repo';
import { encryptCredential } from '@tourbillon/shared/vault-encryption';
import { vaultValuesForRedaction } from './approval-redaction';
import { DUMMY_VAULT_KEY, OTHER_DUMMY_VAULT_KEY, fakeSecretDb, withVaultKey } from './approval-detail-vault.fixture';

function recordingDb() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      const p = Promise.resolve([]) as unknown as Promise<unknown[]> & { values: () => Promise<unknown[]> };
      p.values = () => Promise.resolve([]);
      return p;
    },
  };
  return { db: drizzle(client as never), calls };
}

describe('approval details repo: company scoping in SQL', () => {
  const { db, calls } = recordingDb();
  const repo = createApprovalDetailRepo(db as never);

  it('approval, agent, issues, activity and settings queries all filter on the company', async () => {
    await repo.getApproval('company-a', 'appr-a');
    await repo.getAgent('company-a', 'agent-a');
    await repo.getIssues('company-a', ['issue-1', 'issue-2']);
    await repo.getActivity('company-a', 'appr-a', ['issue-1']);
    await repo.getCompanySettings('company-a');
    assert.equal(calls.length, 5);
    const [approval, agent, issues, activity, settings] = calls;
    assert.match(approval.sql, /from "approvals" where \("approvals"\."id" = \$1 and "approvals"\."company_id" = \$2\)/);
    assert.deepEqual(approval.params.slice(0, 2), ['appr-a', 'company-a']);
    assert.match(agent.sql, /"agents"\."company_id" = \$2/);
    assert.match(issues.sql, /"issues"\."company_id" = \$1 and "issues"\."id" in \(\$2, \$3\)/);
    assert.match(activity.sql, /where \("activity_log"\."company_id" = \$1 and/);
    assert.match(activity.sql, /->>'approvalId' = \$\d+/);
    assert.match(activity.sql, /->>'boardApprovalId' = \$\d+/);
    assert.match(activity.sql, /order by "activity_log"\."created_at" asc/);
    assert.equal(activity.params[0], 'company-a');
    assert.match(settings.sql, /from "companies" where "companies"\."id" = \$1/);
  });

  it('related approvals: same company, not this approval, overlapping issue ids, newest first, capped', async () => {
    calls.length = 0;
    await repo.getRelatedApprovals!('company-a', 'appr-a', ['issue-1', 'issue-2']);
    assert.equal(calls.length, 1);
    const [q] = calls;
    assert.match(q.sql, /from "approvals" where \("approvals"\."company_id" = \$1 and "approvals"\."id" <> \$2 and "approvals"\."issue_ids" && \$3\)/);
    assert.match(q.sql, /order by "approvals"\."created_at" desc limit \$4/);
    assert.deepEqual(q.params.slice(0, 2), ['company-a', 'appr-a']);
    calls.length = 0;
    assert.deepEqual(await repo.getRelatedApprovals!('company-a', 'appr-a', []), []);
    assert.equal(calls.length, 0);
  });

  it('no linked issues: activity is only rows about the approval itself; no issue query', async () => {
    calls.length = 0;
    assert.deepEqual(await repo.getIssues('company-a', []), []);
    await repo.getActivity('company-a', 'appr-a', []);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].sql, /approvalId/);
    assert.match(calls[0].sql, /"activity_log"\."entity_type" = \$\d+ and "activity_log"\."entity_id" = \$\d+/);
  });

  it('secret values: vault and agent rows filtered on the company; provider registry read for keys', async () => {
    calls.length = 0;
    assert.deepEqual(await repo.getSecretValues('company-a'), { values: [], vaultUnavailable: false });
    assert.equal(calls.length, 3);
    const [vault, agentsQ, providers] = calls;
    assert.match(vault.sql, /select "id", "encrypted_value" from "vault_secrets" where "vault_secrets"\."company_id" = \$1/);
    assert.deepEqual(vault.params, ['company-a']);
    assert.match(agentsQ.sql, /select "runtime_config" from "agents" where "agents"\."company_id" = \$1/);
    assert.deepEqual(agentsQ.params, ['company-a']);
    assert.match(providers.sql, /select "api_key", "headers", "base_url" from "llm_providers"/);
  });
});

describe('approval details repo: secret values from real rows', () => {
  it('one vault row and one provider row: both values come back (plus agent runtime secrets)', async () => {
    await withVaultKey(DUMMY_VAULT_KEY, async () => {
      const { db, calls } = fakeSecretDb({
        vault: [{ id: 'vault-row-1', encryptedValue: encryptCredential('dummy-vault-value-0001') }],
        agents: [{ runtimeConfig: { secrets: { GH_TOKEN: 'dummy-runtime-value-0002' } } }],
        providers: [{ apiKey: 'dummy-provider-key-0003', headers: { 'X-Extra': 'dummy-provider-hdr-0004' }, baseURL: 'https://llm.example.test/v1' }],
      });
      const got = await createApprovalDetailRepo(db as never).getSecretValues('company-a');
      assert.equal(got.vaultUnavailable, false);
      for (const v of ['dummy-vault-value-0001', 'dummy-runtime-value-0002', 'dummy-provider-key-0003', 'dummy-provider-hdr-0004']) {
        assert.ok(got.values.includes(v), v);
      }
      assert.deepEqual(calls[0].params, ['company-a']);
    });
  });

  it('a vault row that cannot be decrypted is reported, not dropped', async () => {
    const rows = await withVaultKey(DUMMY_VAULT_KEY, () => ({
      vault: [{ id: 'vault-row-1', encryptedValue: encryptCredential('dummy-vault-value-0001') }],
      agents: [],
      providers: [{ apiKey: 'dummy-provider-key-0003', headers: null, baseURL: 'https://llm.example.test/v1' }],
    }));
    const warn = console.warn;
    console.warn = () => {};
    try {
      const got = await withVaultKey(OTHER_DUMMY_VAULT_KEY, () => createApprovalDetailRepo(fakeSecretDb(rows).db as never).getSecretValues('company-a'));
      assert.equal(got.vaultUnavailable, true);
      assert.ok(got.values.includes('dummy-provider-key-0003'));
    } finally {
      console.warn = warn;
    }
  });
});

describe('approval details repo: vault values for redaction (#130 B3)', () => {
  const quiet = () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    return { logs, log: (m: string, meta: Record<string, unknown>) => logs.push([m, meta]) };
  };

  it('decrypts API-key strings and OAuth access/refresh tokens', async () => {
    await withVaultKey(DUMMY_VAULT_KEY, () => {
      const q = quiet();
      const got = vaultValuesForRedaction(
        [
          { id: 'r1', encryptedValue: encryptCredential('dummy-vault-api-key-1') },
          { id: 'r2', encryptedValue: encryptCredential({ accessToken: 'dummy-access-1', refreshToken: 'dummy-refresh-1' }) },
        ],
        q,
      );
      assert.deepEqual(got, { values: ['dummy-vault-api-key-1', 'dummy-access-1', 'dummy-refresh-1'], vaultUnavailable: false });
      assert.equal(q.logs.length, 0);
    });
  });

  it('no vault rows: nothing to hide, even with no key', async () => {
    await withVaultKey(null, () => assert.deepEqual(vaultValuesForRedaction([], quiet()), { values: [], vaultUnavailable: false }));
  });

  it('key unset, wrong key, or a corrupt row: unavailable; the log has counts and row ids only', async () => {
    const good = await withVaultKey(DUMMY_VAULT_KEY, () => encryptCredential('dummy-vault-api-key-1'));
    const bad = 'bm90LWEtY2lwaGVydGV4dC0wMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';
    const cases: Array<[string, string | null, Array<{ id: string; encryptedValue: string }>, string]> = [
      ['key unset', null, [{ id: 'r1', encryptedValue: good }], 'key_missing'],
      ['wrong key', OTHER_DUMMY_VAULT_KEY, [{ id: 'r1', encryptedValue: good }], 'no_row_decrypts'],
      ['corrupt row', DUMMY_VAULT_KEY, [{ id: 'r1', encryptedValue: good }, { id: 'r2', encryptedValue: bad }], 'row_decrypt_failed'],
    ];
    for (const [name, key, rows, reason] of cases) {
      await withVaultKey(key, () => {
        const q = quiet();
        const got = vaultValuesForRedaction(rows, q);
        assert.equal(got.vaultUnavailable, true, name);
        assert.equal(q.logs.length, 1, name);
        const meta = q.logs[0][1];
        assert.equal(meta.reason, reason, name);
        assert.equal(meta.rows, rows.length, name);
        const logged = JSON.stringify(q.logs);
        assert.ok(!logged.includes('dummy-vault-api-key-1'), name);
        for (const r of rows) assert.ok(!logged.includes(r.encryptedValue), `${name}: ciphertext logged`);
        assert.ok(logged.includes(name === 'corrupt row' ? '"r2"' : '"r1"'), name);
      });
    }
  });

  it('skipUndecryptableRows relaxes only a partial failure, never a missing or wrong key', async () => {
    const good = await withVaultKey(DUMMY_VAULT_KEY, () => encryptCredential('dummy-vault-api-key-1'));
    const rows = [{ id: 'r1', encryptedValue: good }, { id: 'r2', encryptedValue: 'bm90LWEtY2lwaGVydGV4dC0wMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=' }];
    await withVaultKey(DUMMY_VAULT_KEY, () => {
      const got = vaultValuesForRedaction(rows, { ...quiet(), skipUndecryptableRows: true });
      assert.deepEqual(got, { values: ['dummy-vault-api-key-1'], vaultUnavailable: false });
    });
    await withVaultKey(OTHER_DUMMY_VAULT_KEY, () =>
      assert.equal(vaultValuesForRedaction(rows, { ...quiet(), skipUndecryptableRows: true }).vaultUnavailable, true));
    await withVaultKey(null, () =>
      assert.equal(vaultValuesForRedaction(rows, { ...quiet(), skipUndecryptableRows: true }).vaultUnavailable, true));
  });
});
