import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWakeContextConfig, WAKE_CONTEXT_V2_ENV } from './settings';
import { parseCompanySettings, mergeCompanySettings } from '../company-settings';

describe('WC6 resolveWakeContextConfig', () => {
  it('default off with default budgets 2400 / 4500 / 7500', () => {
    const c = resolveWakeContextConfig({}, {});
    assert.equal(c.enabled, false);
    assert.equal(c.source, 'default');
    assert.deepEqual(c.budgets, { headerMaxChars: 2400, commentsMaxChars: 4500, totalSoftMaxChars: 7500 });
  });
  it('env switch turns it on/off; the company setting wins over env', () => {
    assert.equal(resolveWakeContextConfig({}, { [WAKE_CONTEXT_V2_ENV]: '1' }).enabled, true);
    assert.equal(resolveWakeContextConfig({}, { [WAKE_CONTEXT_V2_ENV]: 'off' }).enabled, false);
    const c = resolveWakeContextConfig({ wakeContextV2: false }, { [WAKE_CONTEXT_V2_ENV]: 'true' });
    assert.equal(c.enabled, false);
    assert.equal(c.source, 'company');
    assert.equal(resolveWakeContextConfig({ wakeContextV2: true }, {}).enabled, true);
  });
  it('per-company budget overrides are clamped', () => {
    const c = resolveWakeContextConfig({ wakeContextBudgets: { headerMaxChars: 1200, commentsMaxChars: 10, totalSoftMaxChars: 1e9 } }, {});
    assert.deepEqual(c.budgets, { headerMaxChars: 1200, commentsMaxChars: 1000, totalSoftMaxChars: 40000 });
  });
  it('parseCompanySettings keeps wakeContextV2 / wakeContextBudgets (so settings saves do not drop them)', () => {
    const raw = { wakeContextV2: true, wakeContextBudgets: { headerMaxChars: 2000, bogus: 1, commentsMaxChars: 'x' } };
    const parsed = parseCompanySettings(raw);
    assert.equal(parsed.wakeContextV2, true);
    assert.deepEqual(parsed.wakeContextBudgets, { headerMaxChars: 2000 });
    assert.equal(mergeCompanySettings(raw, { searxngUrl: 'http://s' }).wakeContextV2, true);
    assert.equal(parseCompanySettings({}).wakeContextV2, undefined);
  });
});
