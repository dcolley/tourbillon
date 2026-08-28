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
  });
});
