/**
 * TB hotfix (tbhotfix-redact-CONTRACT.md) — notice payload is redacted and directive-free.
 *
 * Red on main b5ca128:
 *  - failed / waiting_on_user interpolate event.detail RAW and append model directives
 *    (taskProgressSignalPayload L274–286).
 *  - done interpolates title RAW (L265–266) and drops detail (title is still a leak if it has a secret).
 *  - queue/persist only clamp (L124–129, L171–180) — no redaction.
 *
 * CI: add to TB363_TEST_FILES in packages/mastra/scripts/run-tb363-tests.mjs AND the scheduler
 * ci-coverage-s316-s4-s328-s4.test.ts TB363_TEST_FILES pin (~L196).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskProgressSignalPayload } from './concierge-signal';

const F = {
  sk: 'sk-test-ABCDEFGHIJKLMNOPQRSTUVWX',
  ant: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123',
  ghp: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  pat: 'github_pat_11ABCDEFGHIJKLMNOPQRSTUVWX',
  akia: 'AKIAIOSFODNN7EXAMPLE',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0Yi1ob3RmaXgtZml4dHVyZSIsImlhdCI6MX0.tbhotfix-not-a-real-signature',
  pass: 'S3cretPass-Fixture',
};
const SECRETS = [F.sk, F.ant, F.ghp, F.pat, F.akia, F.jwt, F.pass];

const DETAIL =
  `connect failed postgres://alice:${F.pass}@db.example.test:5432/app ` +
  `Authorization: Bearer ${F.sk} ant=${F.ant} git=${F.ghp} pat=${F.pat} aws=${F.akia} jwt=${F.jwt} ` +
  `OPENAI_API_KEY=${F.sk} DATABASE_PASSWORD=${F.pass} ECONNREFUSED exit 137`;

const base = {
  companyId: 'company-1',
  agentId: 'agent-1',
  chatTaskId: 'task-hotfix',
  runId: 'run-hotfix',
  title: 'Search AI news',
};

function blob(stage: 'failed' | 'waiting_on_user' | 'done' | 'started', over: Record<string, unknown> = {}) {
  const p = taskProgressSignalPayload({
    ...base,
    stage,
    status: stage === 'failed' ? 'failed' : 'succeeded',
    ...over,
  } as never);
  return { p, json: JSON.stringify(p) };
}

function assertNoSecrets(json: string, label: string) {
  for (const s of SECRETS) {
    assert.ok(!json.includes(s), `${label}: secret ${s.slice(0, 8)}… must not appear in the payload`);
  }
}

test('MUST-1/M1: failed payload redacts every fixture in contents, attributes, and technical', () => {
  const { p, json } = blob('failed', { detail: DETAIL });
  assertNoSecrets(json, 'failed');
  assert.match(p.contents, /fail/i, 'still a failed notice');
});

test('MUST-2/M3: failed contents hide model-directed instructions', () => {
  const { p } = blob('failed', { detail: DETAIL });
  assert.doesNotMatch(p.contents, /Tell the human/);
  assert.doesNotMatch(p.contents, /do NOT present/i);
  assert.doesNotMatch(p.contents, /offer a retry \(resume re-queues it\)/i);
});

test('MUST-1/M2: waiting_on_user payload redacts secrets in the ask/detail', () => {
  const { json } = blob('waiting_on_user', { detail: `Which region, EU or US? also ${DETAIL}` });
  assertNoSecrets(json, 'waiting_on_user');
});

test('MUST-2/M4: waiting_on_user hides "Ask them for exactly that" but keeps the ask and "reply here"', () => {
  const ask = 'Which region, EU or US?';
  const { p } = blob('waiting_on_user', { detail: ask });
  assert.doesNotMatch(p.contents, /Ask them for exactly that/);
  assert.ok(p.contents.includes(ask), 'exact ask is preserved (TB-363 A2)');
  assert.match(p.contents, /reply here/i);
});

test('MUST-1/M2: done payload redacts a secret in the title', () => {
  const { json, p } = blob('done', { title: `Search AI news key=${F.sk}` });
  assertNoSecrets(json, 'done title');
  assert.match(p.contents, /done/i);
});

test('MUST-1: started payload redacts a secret in the title', () => {
  const { json } = blob('started', { title: `Search AI news token=${F.ghp}` });
  assertNoSecrets(json, 'started title');
});

test('MUST-7/M11: failed notice keeps non-secret failure tokens somewhere in the payload', () => {
  const { json, p } = blob('failed', { detail: DETAIL });
  assert.ok(p.contents.length > 0, 'contents not blanked');
  assert.ok(
    json.includes('ECONNREFUSED') && json.includes('exit 137'),
    'raw tokens survive in the (redacted) technical channel so the toggle has something honest to show',
  );
  assert.ok(json.includes('Search AI news'), 'title preserved');
});

test('MUST-7: waiting_on_user without a secret still relays the ask (guard)', () => {
  const ask = 'Which region, EU or US?';
  const { p, json } = blob('waiting_on_user', { detail: ask });
  assert.ok(p.contents.includes(ask));
  assert.match(p.contents, /reply here/i);
  assertNoSecrets(json, 'clean ask');
});

test('M14: a long secret-bearing detail is redacted, not merely clamped', () => {
  const long = `${'x'.repeat(2000)}${DETAIL}`;
  const { json } = blob('failed', { detail: long });
  assertNoSecrets(json, 'clamped failed detail');
});
