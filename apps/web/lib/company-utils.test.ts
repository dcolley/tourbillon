/**
 * CONCIERGE-PARAMS S1 (gate #195): updateCompanyConciergeModel persisted the concierge pair via
 * an inline mergeCompanySettings call that no test covered — a mutant dropping `params` from the
 * stored pair survived. The merge is now the pure mergeConciergeModelSettings below; these tests
 * pin it (params persisted, pair cleared as a unit, unrelated settings preserved).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeConciergeModelSettings } from './company-utils';
import { resolveConciergeModel } from '@tourbillon/shared';

describe('mergeConciergeModelSettings (CONCIERGE-PARAMS S1)', () => {
  it('stores the pair WITH params and keeps unrelated settings', () => {
    const merged = mergeConciergeModelSettings(
      { searxngUrl: 'http://searx.local', observationalMemory: { enabled: false } },
      { providerId: 'prov-1', modelId: 'snappy-mini', params: { maxContextTokens: 65_536, maxOutputTokens: 2_048 } },
    );
    assert.deepEqual(resolveConciergeModel(merged), {
      providerId: 'prov-1',
      modelId: 'snappy-mini',
      params: { maxContextTokens: 65_536, maxOutputTokens: 2_048 },
    }, 'params must be persisted — dropping them here was the surviving mutant');
    assert.equal(merged.searxngUrl, 'http://searx.local', 'other settings survive the write');
  });

  it('trims ids before storing', () => {
    const merged = mergeConciergeModelSettings(undefined, {
      providerId: '  prov-1 ',
      modelId: ' snappy-mini ',
      params: { maxContextTokens: 32_768 },
    });
    assert.deepEqual(resolveConciergeModel(merged), {
      providerId: 'prov-1',
      modelId: 'snappy-mini',
      params: { maxContextTokens: 32_768 },
    });
  });

  it('an empty modelId (or providerId) clears the WHOLE pair, params included', () => {
    const existing = { conciergeModel: { providerId: 'prov-1', modelId: 'm', params: { maxContextTokens: 65_536 } } };
    assert.equal(resolveConciergeModel(mergeConciergeModelSettings(existing, { providerId: 'prov-1', modelId: '  ' })), null);
    assert.equal(resolveConciergeModel(mergeConciergeModelSettings(existing, {})), null);
    assert.equal(mergeConciergeModelSettings(existing, {}).conciergeModel?.params, undefined, 'no ghost params after clear');
  });

  it('saving without params clears stale params (no ghost window on a re-saved pair)', () => {
    const existing = { conciergeModel: { providerId: 'prov-1', modelId: 'm', params: { maxContextTokens: 65_536 } } };
    const merged = mergeConciergeModelSettings(existing, { providerId: 'prov-1', modelId: 'm' });
    assert.deepEqual(resolveConciergeModel(merged), { providerId: 'prov-1', modelId: 'm' });
  });
});
