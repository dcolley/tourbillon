/**
 * CONCIERGE-PARAMS S234-S2 (#234 ACCEPT): call-site pin for the settings save path.
 *
 * concierge-params.test.ts drives validateConciergeModelParams directly, so nothing pinned
 * that saveConciergeModel in app/(dashboard)/settings/page.tsx actually CALLS it — reverting
 * the action to the old inline min-only loop (the pre-S195-S3 shape) kept the unit suite and
 * tsc green while the server silently stopped enforcing max bounds and output < context.
 * Same class as the #194 S6 / #195 S2 wiring pins: assert on the real call site in source.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, 'page.tsx'), 'utf8');

function saveConciergeModelBody(): string {
  const start = SRC.indexOf('async function saveConciergeModel(');
  assert.ok(start > 0, 'saveConciergeModel server action found in settings/page.tsx');
  // The next top-level server action / component export ends the body slice.
  const next = SRC.indexOf('\nasync function ', start + 1);
  const body = SRC.slice(start, next > start ? next : undefined);
  assert.ok(body.includes('updateCompanyConciergeModel'), 'slice covers the real save action');
  return body;
}

describe('saveConciergeModel → validateConciergeModelParams wiring (S234-S2)', () => {
  it('the settings page imports the shared validator (not an inline copy)', () => {
    assert.match(
      SRC,
      /import\s*\{[^}]*\bvalidateConciergeModelParams\b[^}]*\}\s*from\s*'@\/lib\/concierge-params'/,
      "validateConciergeModelParams must be imported from '@/lib/concierge-params'",
    );
  });

  it('saveConciergeModel calls validateConciergeModelParams with both param fields', () => {
    const body = saveConciergeModelBody();
    assert.match(
      body,
      /validateConciergeModelParams\s*\(/,
      'removing the validate call (back to the old min-only loop) must RED here',
    );
    assert.match(body, /params\.maxContextTokens/, 'the form field params.maxContextTokens feeds the validator');
    assert.match(body, /params\.maxOutputTokens/, 'the form field params.maxOutputTokens feeds the validator');
  });

  it('a failed validation short-circuits before the DB write', () => {
    const body = saveConciergeModelBody();
    const validateAt = body.search(/validateConciergeModelParams\s*\(/);
    const shortCircuit = body.search(/if\s*\(\s*!\s*validated\.ok\s*\)/);
    const writeAt = body.indexOf('updateCompanyConciergeModel(');
    assert.ok(shortCircuit > validateAt, 'the !validated.ok guard must follow the validate call');
    assert.ok(
      /actionError\(/.test(body.slice(shortCircuit, writeAt)),
      'the guard returns actionError(...) before any write',
    );
    assert.ok(validateAt < writeAt, 'validation runs before updateCompanyConciergeModel');
  });

  it('the persisted params come from the validator result, not raw form data', () => {
    const body = saveConciergeModelBody();
    assert.match(
      body,
      /params\s*[:=]\s*validated\.params|params,\s*\n?\s*\}\);?[\s\S]{0,40}updateCompanyConciergeModel|validated\.params/,
      'updateCompanyConciergeModel must persist validated.params (coerced numbers), not raw strings',
    );
    assert.doesNotMatch(
      body,
      /params:\s*\{\s*maxContextTokens:\s*formData/,
      'raw formData must not be passed through as params',
    );
  });
});
