/**
 * TB hotfix (tbhotfix-redact-CONTRACT.md) — the single redactor, `redactErrorText`.
 *
 * Red on main b5ca128: the module does not exist (MUST-1 / M10).
 * CI: auto-run by `pnpm --filter @tourbillon/shared test:unit` (already in .github/workflows/ci.yml
 * and pinned in packages/scheduler/src/ci-coverage-s316-s4-s328-s4.test.ts). Do not exclude.
 *
 * After #364 merges, apps/web/lib/agui/redact-error.ts must re-export this same function.
 * Fixtures are synthetic only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactErrorText } from './redact-error';

const F = {
  sk: 'sk-test-ABCDEFGHIJKLMNOPQRSTUVWX',
  ant: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123',
  ghp: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  pat: 'github_pat_11ABCDEFGHIJKLMNOPQRSTUVWX',
  akia: 'AKIAIOSFODNN7EXAMPLE',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0Yi1ob3RmaXgtZml4dHVyZSIsImlhdCI6MX0.tbhotfix-not-a-real-signature',
  pass: 'S3cretPass-Fixture',
};

const CASES: Array<{ id: string; haystack: string; needles: string[] }> = [
  { id: 'F1 sk-test-', haystack: `provider error key=${F.sk} exit 137`, needles: [F.sk] },
  { id: 'F2 sk-ant-', haystack: `anthropic rejected ${F.ant}`, needles: [F.ant] },
  { id: 'F3 ghp_', haystack: `git clone failed token=${F.ghp}`, needles: [F.ghp] },
  { id: 'F4 github_pat_', haystack: `auth: ${F.pat} was invalid`, needles: [F.pat] },
  { id: 'F5 Bearer', haystack: `Authorization: Bearer ${F.sk} upstream 401`, needles: [F.sk] },
  { id: 'F6 AKIA', haystack: `aws accessKey=${F.akia} region=us-east-1`, needles: [F.akia] },
  { id: 'F7 JWT', haystack: `token=${F.jwt} expired`, needles: [F.jwt] },
  {
    id: 'F8 URL userinfo',
    haystack: `connect failed postgres://alice:${F.pass}@db.example.test:5432/app ECONNREFUSED`,
    needles: [F.pass],
  },
  {
    id: 'F9 env lines',
    haystack: `env dump OPENAI_API_KEY=${F.sk} DATABASE_PASSWORD=${F.pass} exit 137`,
    needles: [F.sk, F.pass],
  },
];

for (const c of CASES) {
  test(`M10 ${c.id}: secret material is removed`, () => {
    const out = redactErrorText(c.haystack);
    for (const n of c.needles) {
      assert.ok(!out.includes(n), `${c.id}: ${n.slice(0, 8)}… must not survive; got: ${out}`);
    }
  });
}

test('M11 negatives: non-secret tokens are preserved', () => {
  const out = redactErrorText(
    `Background task failed: ECONNREFUSED exit 137. Which region, EU or US? They can reply here. Search AI news.`,
  );
  for (const n of ['ECONNREFUSED', 'exit 137', 'Which region, EU or US?', 'reply here', 'Search AI news']) {
    assert.ok(out.includes(n), `negative "${n}" must survive; got: ${out}`);
  }
});

test('M14 redact before clamp: a secret sitting past a short cap is not leaked as a prefix', () => {
  const out = redactErrorText(`ok ${'x'.repeat(2500)} key=${F.sk}`);
  assert.ok(!out.includes(F.sk), 'secret after a long prefix must still be redacted');
  assert.ok(out.length <= 2000 + 32, `technical cap ~2000; got ${out.length}`);
});

test('M10 combined haystack (all fixtures at once)', () => {
  const hay = [
    F.sk, F.ant, F.ghp, F.pat, `Bearer ${F.sk}`, F.akia, F.jwt,
    `postgres://alice:${F.pass}@db.example.test:5432/app`,
    `OPENAI_API_KEY=${F.sk}`, `DATABASE_PASSWORD=${F.pass}`,
  ].join(' ');
  const out = redactErrorText(hay);
  for (const n of [F.sk, F.ant, F.ghp, F.pat, F.akia, F.jwt, F.pass]) {
    assert.ok(!out.includes(n), `combined: ${n.slice(0, 8)}… leaked`);
  }
});
