/**
 * CONCIERGE-PARAMS S195-S3 (#195 ACCEPT): server-side validation of the concierge model
 * params. The pre-existing action checked only minimums; these tests go RED when a check
 * is removed:
 *   - drop the upper-bound legs  -> "at most" cases fail
 *   - drop the output<context leg -> the >= cases pass and fail here
 * The bounds-vs-form pin keeps the server constants honest with the number inputs in
 * components/concierge-model-settings-form.tsx (the "align with form max" of the soft).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONCIERGE_PARAM_BOUNDS, validateConciergeModelParams } from './concierge-params';

describe('validateConciergeModelParams (S195-S3)', () => {
  it('blank on both means unset (no params, no error)', () => {
    assert.deepEqual(validateConciergeModelParams({}), { ok: true, params: {} });
    assert.deepEqual(validateConciergeModelParams({ maxContextTokens: '', maxOutputTokens: '  ' }), { ok: true, params: {} });
  });

  it('accepts in-range values and keeps unset keys out of params', () => {
    assert.deepEqual(
      validateConciergeModelParams({ maxContextTokens: '65536', maxOutputTokens: '4096' }),
      { ok: true, params: { maxContextTokens: 65_536, maxOutputTokens: 4_096 } },
    );
    assert.deepEqual(validateConciergeModelParams({ maxOutputTokens: '2048' }), { ok: true, params: { maxOutputTokens: 2_048 } });
    assert.deepEqual(validateConciergeModelParams({ maxContextTokens: '1048576' }), { ok: true, params: { maxContextTokens: 1_048_576 } });
  });

  it('rejects below minimum or non-integer (pre-existing minimum legs stay alive)', () => {
    assert.equal(validateConciergeModelParams({ maxContextTokens: '7999' }).ok, false);
    assert.equal(validateConciergeModelParams({ maxOutputTokens: '1023' }).ok, false);
    assert.equal(validateConciergeModelParams({ maxContextTokens: '65536.5' }).ok, false);
    assert.equal(validateConciergeModelParams({ maxOutputTokens: 'abc' }).ok, false);
    assert.match((validateConciergeModelParams({ maxContextTokens: '7999' }) as { error: string }).error, /at least 8000/);
  });

  it('rejects above the upper bound (new: the old server check had no max)', () => {
    const overContext = validateConciergeModelParams({ maxContextTokens: '1048577' });
    assert.equal(overContext.ok, false);
    assert.match((overContext as { error: string }).error, /at most 1048576/);
    const overOutput = validateConciergeModelParams({ maxOutputTokens: '131073' });
    assert.equal(overOutput.ok, false);
    assert.match((overOutput as { error: string }).error, /at most 131072/);
  });

  it('rejects output >= context when both are set (new: the old server check related neither)', () => {
    // Equal and greater are both invalid — the comparison must be strict output < context.
    assert.equal(validateConciergeModelParams({ maxContextTokens: '65536', maxOutputTokens: '65536' }).ok, false);
    assert.equal(validateConciergeModelParams({ maxContextTokens: '65536', maxOutputTokens: '65537' }).ok, false);
    assert.equal(validateConciergeModelParams({ maxContextTokens: '8000', maxOutputTokens: '131072' }).ok, false);
    // Adjacent-but-valid stays green so the boundary is exactly >=.
    assert.equal(validateConciergeModelParams({ maxContextTokens: '65536', maxOutputTokens: '65535' }).ok, true);
    assert.match(
      (validateConciergeModelParams({ maxContextTokens: '65536', maxOutputTokens: '65536' }) as { error: string }).error,
      /below max context tokens/,
    );
  });

  it('cross-check applies only when BOTH are set (one blank = provider default, nothing to compare)', () => {
    // 131072 output is fine on its own — the provider default window may be larger.
    assert.equal(validateConciergeModelParams({ maxOutputTokens: '131072' }).ok, true);
    // 8000 context alone is fine too — output would fall back to the provider default.
    assert.equal(validateConciergeModelParams({ maxContextTokens: '8000' }).ok, true);
  });

  it('bounds match the form inputs (align-with-form-max pin; drift fails here first)', () => {
    assert.deepEqual(CONCIERGE_PARAM_BOUNDS, {
      maxContextTokens: { min: 8_000, max: 1_048_576 },
      maxOutputTokens: { min: 1_024, max: 131_072 },
    });
    const form = readFileSync(join(__dirname, '..', 'components', 'concierge-model-settings-form.tsx'), 'utf8');
    assert.match(form, /name="params\.maxContextTokens"[\s\S]{0,400}?min="8000"[\s\S]{0,80}?max="1048576"/, 'form min/max for maxContextTokens must match the server bounds');
    assert.match(form, /name="params\.maxOutputTokens"[\s\S]{0,400}?min="1024"[\s\S]{0,80}?max="131072"/, 'form min/max for maxOutputTokens must match the server bounds');
  });
});
