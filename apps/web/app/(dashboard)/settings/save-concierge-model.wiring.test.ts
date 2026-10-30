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

/**
 * S237-S2 (#237 ACCEPT): the persistence pins below must see CODE, not prose. Strip block
 * and line comments from the body slice so a comment merely mentioning `validated.params`
 * cannot satisfy them (mutant M6 persisted raw formData + such a comment and survived the
 * old catch-all regex). Naive strip: `//` inside string literals in this body is only ever
 * part of `http://`-style URLs, which none of the pins look for.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * S239-S1 (#239 ACCEPT): slice between `callOpen` (e.g. 'f(') and its matching close
 * paren, so pins can assert on the ARGUMENTS of a call rather than the whole body.
 * Call on comment-stripped code only (see stripComments).
 */
function callArguments(code: string, callOpen: string): string {
  const openAt = code.indexOf(callOpen);
  assert.ok(openAt >= 0, `${callOpen} found in the body slice`);
  let depth = 1;
  for (let i = openAt + callOpen.length; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(openAt + callOpen.length, i);
    }
  }
  assert.fail(`${callOpen} has no matching close paren in the body slice`);
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
    // S237-S2: match on comment-stripped code and no trailing `|validated\.params`
    // catch-all — any prose mention of validated.params (comments included) used to
    // satisfy the pin while raw formData was actually persisted (mutant M6).
    const code = stripComments(saveConciergeModelBody());
    assert.match(
      code,
      /const\s+params\s*=\s*validated\.params\s*;|params\s*:\s*validated\.params/,
      'params must be pinned to validated.params (const params = validated.params; or params: validated.params) before the write',
    );
    const writeAt = code.indexOf('updateCompanyConciergeModel(');
    const pinAt = code.search(/const\s+params\s*=\s*validated\.params\s*;|params\s*:\s*validated\.params/);
    assert.ok(pinAt >= 0 && pinAt < writeAt, 'the params pin must sit before updateCompanyConciergeModel(');
    assert.doesNotMatch(
      code,
      /params:\s*\{\s*maxContextTokens:\s*formData/,
      'raw formData must not be passed through as params',
    );

    // S239-S1: the pins above only proved a `validated.params` binding EXISTS somewhere
    // before the call — a mutant keeping `const params = validated.params;` while
    // persisting raw formData into the write object (e.g. inline
    // `params: { maxContextTokens: formData.get(...) }`) still survived them. Assert on
    // the actual ARGUMENTS of updateCompanyConciergeModel: the persisted value must be
    // the pinned `params` binding (shorthand or `params: params`), and raw formData must
    // not appear in the call at all.
    const args = callArguments(code, 'updateCompanyConciergeModel(');
    assert.match(
      args,
      /(?:^|[{,[]|\s)params\s*(?:[:,]\s*params)?\s*(?:[,}\]])/,
      'the write must pass the pinned `params` binding (shorthand or params: params) as the params value',
    );
    assert.doesNotMatch(
      args,
      /\bformData\b/,
      'no raw formData may appear in the updateCompanyConciergeModel(...) arguments',
    );
  });
});
