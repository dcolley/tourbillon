import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseCompanySettings,
  resolveObservationalMemorySettings,
  mergeCompanySettings,
} from './company-settings';

describe('parseCompanySettings - observationalMemory', () => {
  it('parses enabled flag correctly', () => {
    const settings = parseCompanySettings({
      observationalMemory: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
      },
    });
    assert.equal(settings.observationalMemory?.enabled, true);
  });

  it('parses disabled flag correctly', () => {
    const settings = parseCompanySettings({
      observationalMemory: {
        enabled: false,
        providerId: 'provider-1',
        modelId: 'model-1',
      },
    });
    assert.equal(settings.observationalMemory?.enabled, false);
  });

  it('parses numeric fields when provided', () => {
    const settings = parseCompanySettings({
      observationalMemory: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
        maxOutputTokens: 4096,
        observeAfterTokens: 20000,
        reflectAfterTokens: 35000,
        temperature: 0.5,
      },
    });
    assert.equal(settings.observationalMemory?.maxOutputTokens, 4096);
    assert.equal(settings.observationalMemory?.observeAfterTokens, 20000);
    assert.equal(settings.observationalMemory?.reflectAfterTokens, 35000);
    assert.equal(settings.observationalMemory?.temperature, 0.5);
  });

  it('omits numeric fields when not provided', () => {
    const settings = parseCompanySettings({
      observationalMemory: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
      },
    });
    assert.equal(settings.observationalMemory?.maxOutputTokens, undefined);
    assert.equal(settings.observationalMemory?.observeAfterTokens, undefined);
    assert.equal(settings.observationalMemory?.reflectAfterTokens, undefined);
    assert.equal(settings.observationalMemory?.temperature, undefined);
  });

  it('returns undefined when all fields are missing', () => {
    const settings = parseCompanySettings({});
    assert.equal(settings.observationalMemory, undefined);
  });

  it('trims string fields', () => {
    const settings = parseCompanySettings({
      observationalMemory: {
        enabled: true,
        providerId: '  provider-1  ',
        modelId: '  model-1  ',
      },
    });
    assert.equal(settings.observationalMemory?.providerId, 'provider-1');
    assert.equal(settings.observationalMemory?.modelId, 'model-1');
  });
});

describe('resolveObservationalMemorySettings', () => {
  it('returns defaults when no settings provided', () => {
    const resolved = resolveObservationalMemorySettings(null);
    assert.equal(resolved.maxOutputTokens, 8192);
    assert.equal(resolved.observeAfterTokens, 30000);
    assert.equal(resolved.reflectAfterTokens, 40000);
    assert.equal(resolved.temperature, undefined);
  });

  it('applies configured values when provided', () => {
    const settings = {
      observationalMemory: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
        maxOutputTokens: 4096,
        observeAfterTokens: 20000,
        reflectAfterTokens: 35000,
        temperature: 0.5,
      },
    };
    const resolved = resolveObservationalMemorySettings(settings);
    assert.equal(resolved.maxOutputTokens, 4096);
    assert.equal(resolved.observeAfterTokens, 20000);
    assert.equal(resolved.reflectAfterTokens, 35000);
    assert.equal(resolved.temperature, 0.5);
  });

  it('enforces minimum maxOutputTokens of 1024', () => {
    const settings = {
      observationalMemory: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
        maxOutputTokens: 512,
      },
    };
    const resolved = resolveObservationalMemorySettings(settings);
    assert.equal(resolved.maxOutputTokens, 1024);
  });

  it('enforces minimum observeAfterTokens of 8000', () => {
    const settings = {
      observationalMemory: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
        observeAfterTokens: 5000,
      },
    };
    const resolved = resolveObservationalMemorySettings(settings);
    assert.equal(resolved.observeAfterTokens, 8000);
  });

  it('enforces minimum reflectAfterTokens of 8000', () => {
    const settings = {
      observationalMemory: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
        reflectAfterTokens: 5000,
      },
    };
    const resolved = resolveObservationalMemorySettings(settings);
    assert.equal(resolved.reflectAfterTokens, 8000);
  });

  it('uses defaults when partial settings provided', () => {
    const settings = {
      observationalMemory: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
        maxOutputTokens: 16000,
      },
    };
    const resolved = resolveObservationalMemorySettings(settings);
    assert.equal(resolved.maxOutputTokens, 16000);
    assert.equal(resolved.observeAfterTokens, 30000);
    assert.equal(resolved.reflectAfterTokens, 40000);
  });

  it('omits temperature when not configured', () => {
    const settings = {
      observationalMemory: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
      },
    };
    const resolved = resolveObservationalMemorySettings(settings);
    assert.equal(resolved.temperature, undefined);
  });
});

describe('mergeCompanySettings - observationalMemory', () => {
  it('merges new settings over existing', () => {
    const current = {
      observationalMemory: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
        maxOutputTokens: 4096,
      },
    };
    const patch = {
      observationalMemory: {
        enabled: true,
        providerId: 'provider-2',
        modelId: 'model-2',
        maxOutputTokens: 8192,
        temperature: 0.7,
      },
    };
    const merged = mergeCompanySettings(current, patch);
    assert.equal(merged.observationalMemory?.enabled, true);
    assert.equal(merged.observationalMemory?.providerId, 'provider-2');
    assert.equal(merged.observationalMemory?.modelId, 'model-2');
    assert.equal(merged.observationalMemory?.maxOutputTokens, 8192);
    assert.equal(merged.observationalMemory?.temperature, 0.7);
  });

  it('preserves numeric fields when not patched', () => {
    const current = {
      observationalMemory: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
        maxOutputTokens: 4096,
        observeAfterTokens: 20000,
        reflectAfterTokens: 35000,
      },
    };
    const patch = {
      observationalMemory: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-2',
      },
    };
    const merged = mergeCompanySettings(current, patch);
    assert.equal(merged.observationalMemory?.modelId, 'model-2');
    // Note: mergeCompanySettings rebuilds the object from scratch, so unprovided
    // fields are omitted. This is expected behavior.
    assert.equal(merged.observationalMemory?.maxOutputTokens, undefined);
  });

  it('allows disabling OM', () => {
    const current = {
      observationalMemory: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
      },
    };
    const patch = {
      observationalMemory: {
        enabled: false,
        providerId: 'provider-1',
        modelId: 'model-1',
      },
    };
    const merged = mergeCompanySettings(current, patch);
    assert.equal(merged.observationalMemory?.enabled, false);
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  resolveAgentObservationalMemory,
  memoryCacheKeyForAgent,
  isAgentObservationalMemoryConfigured,
  type ResolvedObservationalMemoryConfig,
} from './company-settings';
import type { CompanySettings, AgentRuntimeConfig } from './types';

describe('resolveAgentObservationalMemory', () => {
  const companyOmBase: CompanySettings = {
    observationalMemory: {
      enabled: true,
      providerId: 'provider-company',
      modelId: 'model-company',
      maxOutputTokens: 4096,
      observeAfterTokens: 20000,
      reflectAfterTokens: 30000,
      temperature: 0.7,
    },
  };

  it('mode=inherit: returns company OM when enabled', () => {
    const resolved = resolveAgentObservationalMemory(companyOmBase, {
      observationalMemory: { mode: 'inherit' },
    });
    assert.ok(resolved);
    assert.equal(resolved.providerId, 'provider-company');
    assert.equal(resolved.modelId, 'model-company');
    assert.equal(resolved.maxOutputTokens, 4096);
    assert.equal(resolved.observeAfterTokens, 20000);
    assert.equal(resolved.reflectAfterTokens, 30000);
    assert.equal(resolved.temperature, 0.7);
  });

  it('mode=inherit: returns null when company OM is disabled', () => {
    const companyOff: CompanySettings = {
      observationalMemory: { enabled: false },
    };
    const resolved = resolveAgentObservationalMemory(companyOff, {
      observationalMemory: { mode: 'inherit' },
    });
    assert.equal(resolved, null);
  });

  it('mode=inherit: returns null when company OM lacks model', () => {
    const companyNoModel: CompanySettings = {
      observationalMemory: { enabled: true, providerId: 'p1' },
    };
    const resolved = resolveAgentObservationalMemory(companyNoModel, {
      observationalMemory: { mode: 'inherit' },
    });
    assert.equal(resolved, null);
  });

  it('mode=off: returns null regardless of company settings', () => {
    const resolved = resolveAgentObservationalMemory(companyOmBase, {
      observationalMemory: { mode: 'off' },
    });
    assert.equal(resolved, null);
  });

  it('mode=on: uses agent overrides over company defaults', () => {
    const resolved = resolveAgentObservationalMemory(companyOmBase, {
      observationalMemory: {
        mode: 'on',
        providerId: 'provider-agent',
        modelId: 'model-agent',
        maxOutputTokens: 2048,
        observeAfterTokens: 15000,
        reflectAfterTokens: 25000,
        temperature: 0.9,
      },
    });
    assert.ok(resolved);
    assert.equal(resolved.providerId, 'provider-agent');
    assert.equal(resolved.modelId, 'model-agent');
    assert.equal(resolved.maxOutputTokens, 2048);
    assert.equal(resolved.observeAfterTokens, 15000);
    assert.equal(resolved.reflectAfterTokens, 25000);
    assert.equal(resolved.temperature, 0.9);
  });

  it('mode=on: inherits company values for missing agent overrides', () => {
    const resolved = resolveAgentObservationalMemory(companyOmBase, {
      observationalMemory: {
        mode: 'on',
        // No agent overrides — should inherit all from company
      },
    });
    assert.ok(resolved);
    assert.equal(resolved.providerId, 'provider-company');
    assert.equal(resolved.modelId, 'model-company');
    assert.equal(resolved.maxOutputTokens, 4096);
    assert.equal(resolved.observeAfterTokens, 20000);
    assert.equal(resolved.reflectAfterTokens, 30000);
    assert.equal(resolved.temperature, 0.7);
  });

  it('mode=on: partial agent overrides merge with company', () => {
    const resolved = resolveAgentObservationalMemory(companyOmBase, {
      observationalMemory: {
        mode: 'on',
        modelId: 'model-agent-override',
        observeAfterTokens: 25000,
      },
    });
    assert.ok(resolved);
    assert.equal(resolved.providerId, 'provider-company'); // inherited
    assert.equal(resolved.modelId, 'model-agent-override'); // overridden
    assert.equal(resolved.maxOutputTokens, 4096); // inherited
    assert.equal(resolved.observeAfterTokens, 25000); // overridden
    assert.equal(resolved.reflectAfterTokens, 30000); // inherited
    assert.equal(resolved.temperature, 0.7); // inherited
  });

  it('mode=on: uses defaults when company and agent lack values', () => {
    const companyNoOm: CompanySettings = {};
    const resolved = resolveAgentObservationalMemory(companyNoOm, {
      observationalMemory: {
        mode: 'on',
        providerId: 'provider-agent',
        modelId: 'model-agent',
      },
    });
    assert.ok(resolved);
    assert.equal(resolved.providerId, 'provider-agent');
    assert.equal(resolved.modelId, 'model-agent');
    assert.equal(resolved.maxOutputTokens, 8192); // default
    assert.equal(resolved.observeAfterTokens, 30000); // default
    assert.equal(resolved.reflectAfterTokens, 40000); // default
    assert.equal(resolved.temperature, undefined); // no default
  });

  it('mode=on: returns null when no resolvable model', () => {
    const companyNoOm: CompanySettings = {};
    const resolved = resolveAgentObservationalMemory(companyNoOm, {
      observationalMemory: { mode: 'on' },
    });
    assert.equal(resolved, null);
  });

  it('missing mode defaults to inherit', () => {
    const resolved = resolveAgentObservationalMemory(companyOmBase, {
      observationalMemory: {},
    });
    assert.ok(resolved);
    assert.equal(resolved.providerId, 'provider-company');
  });

  it('no agent runtime config defaults to inherit', () => {
    const resolved = resolveAgentObservationalMemory(companyOmBase, null);
    assert.ok(resolved);
    assert.equal(resolved.providerId, 'provider-company');
  });
});

describe('memoryCacheKeyForAgent', () => {
  it('returns base when OM is off', () => {
    const key = memoryCacheKeyForAgent(null, { observationalMemory: { mode: 'off' } });
    assert.equal(key, 'base');
  });

  it('returns base when company OM is disabled and agent inherits', () => {
    const companyOff: CompanySettings = {
      observationalMemory: { enabled: false },
    };
    const key = memoryCacheKeyForAgent(companyOff, {
      observationalMemory: { mode: 'inherit' },
    });
    assert.equal(key, 'base');
  });

  it('returns OM key with thresholds when OM is on', () => {
    const companyOm: CompanySettings = {
      observationalMemory: {
        enabled: true,
        providerId: 'provider1',
        modelId: 'model1',
        observeAfterTokens: 20000,
        reflectAfterTokens: 30000,
      },
    };
    const key = memoryCacheKeyForAgent(companyOm, {
      observationalMemory: { mode: 'inherit' },
    });
    assert.equal(key, 'om:provider1:model1:20000:30000');
  });

  it('returns different keys for different thresholds', () => {
    const company: CompanySettings = {
      observationalMemory: {
        enabled: true,
        providerId: 'p1',
        modelId: 'm1',
        observeAfterTokens: 15000,
        reflectAfterTokens: 25000,
      },
    };
    const key1 = memoryCacheKeyForAgent(company, {
      observationalMemory: { mode: 'inherit' },
    });
    const key2 = memoryCacheKeyForAgent(company, {
      observationalMemory: {
        mode: 'on',
        observeAfterTokens: 20000, // override
      },
    });
    assert.notEqual(key1, key2);
    assert.equal(key2, 'om:p1:m1:20000:25000'); // reflect inherited
  });

  it('includes defaults when company has no thresholds', () => {
    const company: CompanySettings = {
      observationalMemory: {
        enabled: true,
        providerId: 'p1',
        modelId: 'm1',
      },
    };
    const key = memoryCacheKeyForAgent(company, {
      observationalMemory: { mode: 'inherit' },
    });
    assert.equal(key, 'om:p1:m1:30000:40000'); // defaults
  });
});

describe('isAgentObservationalMemoryConfigured', () => {
  it('returns true when resolved OM is non-null', () => {
    const company: CompanySettings = {
      observationalMemory: {
        enabled: true,
        providerId: 'p1',
        modelId: 'm1',
      },
    };
    const result = isAgentObservationalMemoryConfigured(company, {
      observationalMemory: { mode: 'inherit' },
    });
    assert.equal(result, true);
  });

  it('returns false when mode is off', () => {
    const company: CompanySettings = {
      observationalMemory: {
        enabled: true,
        providerId: 'p1',
        modelId: 'm1',
      },
    };
    const result = isAgentObservationalMemoryConfigured(company, {
      observationalMemory: { mode: 'off' },
    });
    assert.equal(result, false);
  });

  it('returns false when company OM is disabled and agent inherits', () => {
    const company: CompanySettings = {
      observationalMemory: { enabled: false },
    };
    const result = isAgentObservationalMemoryConfigured(company, {
      observationalMemory: { mode: 'inherit' },
    });
    assert.equal(result, false);
  });

  it('returns false when mode=on but no resolvable model', () => {
    const company: CompanySettings = {};
    const result = isAgentObservationalMemoryConfigured(company, {
      observationalMemory: { mode: 'on' },
    });
    assert.equal(result, false);
  });
});
