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
    const writeAt = code.indexOf('updateCompanyConciergeModel(');
    assert.ok(writeAt >= 0, 'updateCompanyConciergeModel( exists in the body slice');
    const args = callArguments(code, 'updateCompanyConciergeModel(');

    // S244-S3: the validator result may be pinned either as a statement before the write
    // (const params = validated.params;) or inline in the call (params: validated.params) —
    // both are equivalent, so the before-the-write ordering check only applies to the
    // statement form.
    const constPinAt = code.search(/const\s+params\s*=\s*validated\.params\s*;/);
    const pinnedToValidator =
      (constPinAt >= 0 && constPinAt < writeAt) ||
      /(?:^|[{,[])\s*params\s*:\s*validated\.params\s*(?:[,}\]]|$)/.test(args);
    assert.ok(
      pinnedToValidator,
      'params must be pinned to validated.params (const params = validated.params; before the write, or params: validated.params inline in the call)',
    );
    assert.doesNotMatch(
      code,
      /params:\s*\{\s*maxContextTokens:\s*formData/,
      'raw formData must not be passed through as params',
    );

    // S239-S1 / S244-S2: assert on the actual ARGUMENTS of updateCompanyConciergeModel.
    // The persisted value must be EXACTLY the pinned binding: `params`, `params: params`
    // or (S244-S3) `params: validated.params`. S244-S2 closed the loose-token hole: the
    // key match is anchored to a delimiter position and its value must be the WHOLE
    // binding, so `params: fallback ?? params` REDs (the trailing `params` in an
    // expression has no delimiter before it and the key's value is not the binding);
    // likewise nothing may overwrite the binding after it — no spread (mutant M6:
    // `params, ...extra` with formData inside `extra`) and no duplicate params key.
    const paramsBinding = /(?:^|[{,[])\s*params\s*(?::\s*(?:validated\.)?params\s*)?(?=[,}\]]|$)/.exec(args);
    if (!paramsBinding) {
      assert.fail(
        'the write must pass the pinned `params` binding exactly (params, params: params, or params: validated.params) as the params value — params: fallback ?? params must RED',
      );
    }
    const afterBinding = args.slice(paramsBinding.index + paramsBinding[0].length);
    assert.doesNotMatch(
      afterBinding,
      /\.\.\./,
      'no spread may appear after the params binding and overwrite it (params, ...extra must RED)',
    );
    assert.doesNotMatch(
      afterBinding,
      /(?:^|[{,[])\s*params\s*:/,
      'no duplicate params key may redeclare the binding after it (params, params: <other> must RED)',
    );
    assert.doesNotMatch(
      args,
      /\bformData\b/,
      'no raw formData may appear in the updateCompanyConciergeModel(...) arguments',
    );
  });
});
