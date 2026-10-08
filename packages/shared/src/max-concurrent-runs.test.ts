import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_CONCURRENT_RUNS_ERROR,
  mergeCompanySettings,
  parseCompanySettings,
  parseMaxConcurrentRunsInput,
  resolveMaxConcurrentRuns,
} from './company-settings';

describe('maxConcurrentRuns input validation', () => {
  it('accepts positive whole numbers (string or number)', () => {
    assert.deepEqual(parseMaxConcurrentRunsInput('3'), { ok: true, value: 3 });
    assert.deepEqual(parseMaxConcurrentRunsInput(' 12 '), { ok: true, value: 12 });
    assert.deepEqual(parseMaxConcurrentRunsInput(1), { ok: true, value: 1 });
  });

  it('blank, null and undefined mean no cap', () => {
    assert.deepEqual(parseMaxConcurrentRunsInput(''), { ok: true, value: null });
    assert.deepEqual(parseMaxConcurrentRunsInput('   '), { ok: true, value: null });
    assert.deepEqual(parseMaxConcurrentRunsInput(null), { ok: true, value: null });
    assert.deepEqual(parseMaxConcurrentRunsInput(undefined), { ok: true, value: null });
  });

  it('rejects 0, negatives, non-integers and junk', () => {
    for (const bad of [0, '0', -1, '-1', -5, 1.5, '1.5', '2.0', '1e3', 'abc', '3abc', NaN, Infinity,
      '99999999999999999999', true, {}, []]) {
      const r = parseMaxConcurrentRunsInput(bad);
      assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
      if (!r.ok) assert.equal(r.error, MAX_CONCURRENT_RUNS_ERROR);
    }
  });
});

describe('maxConcurrentRuns in company settings (jsonb)', () => {
  it('unset → no cap (null), so default behaviour is unchanged', () => {
    assert.equal(resolveMaxConcurrentRuns(parseCompanySettings({})), null);
    assert.equal(resolveMaxConcurrentRuns(null), null);
    assert.equal('maxConcurrentRuns' in parseCompanySettings({ wakeContextV2: true }), false);
  });

  it('parses a stored positive integer and ignores invalid stored values', () => {
    assert.equal(parseCompanySettings({ maxConcurrentRuns: 4 }).maxConcurrentRuns, 4);
    for (const bad of [0, -2, 2.5, '3', null]) {
      const parsed = parseCompanySettings({ maxConcurrentRuns: bad });
      assert.equal(parsed.maxConcurrentRuns, undefined, `stored ${JSON.stringify(bad)}`);
      assert.equal(resolveMaxConcurrentRuns(parsed), null);
    }
  });

  it('merge sets, keeps (on unrelated saves) and clears with null', () => {
    const set = mergeCompanySettings({ wakeContextV2: true, tavilyApiKey: 'k' }, { maxConcurrentRuns: 2 });
    assert.equal(set.maxConcurrentRuns, 2);
    assert.equal(set.wakeContextV2, true);
    assert.equal(set.tavilyApiKey, 'k');

    const unrelated = mergeCompanySettings(set, { searxngUrl: 'http://s' });
    assert.equal(unrelated.maxConcurrentRuns, 2, 'other settings saves must not wipe the cap');

    const cleared = mergeCompanySettings(unrelated, { maxConcurrentRuns: null });
    assert.equal('maxConcurrentRuns' in cleared, false);
    assert.equal(cleared.searxngUrl, 'http://s');
  });

  it('merge refuses an invalid cap instead of storing it', () => {
    for (const bad of [0, -1, 1.5]) {
      assert.throws(() => mergeCompanySettings({}, { maxConcurrentRuns: bad }), RangeError);
    }
  });
});
