/**
 * CHAT-5: thread model choice helpers — stored-choice parsing, the picker's provider filter
 * (company-enabled only) and the effort levels offered per model.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_THREAD_MODEL_KEY,
  effortForModel,
  effortLevelsForModel,
  parseThreadModelChoice,
  pickerProvidersForCompany,
  threadModelChoiceFromMetadata,
} from './thread-model';
import { ASSISTANT_THREAD_METADATA_KEYS, ASSISTANT_THREAD_MODEL_METADATA_KEY } from './sidebar';

describe('CHAT-5 pickerProvidersForCompany', () => {
  const providers = [
    { id: 'p-on', name: 'On', type: 'openai', enabledForCompany: true, baseURL: 'https://on.example/v1', hasApiKey: true },
    { id: 'p-off', name: 'Off', type: 'openai', enabledForCompany: false, baseURL: 'https://off.example/v1', hasApiKey: true },
    { id: 'p-lm', name: 'LM', type: 'lmstudio', enabledForCompany: true, baseURL: 'http://lm.example:1234', hasApiKey: false },
  ];

  it('lists only providers switched on for the company, in order', () => {
    assert.deepEqual(
      pickerProvidersForCompany(providers).map((p) => p.id),
      ['p-on', 'p-lm'],
    );
  });

  it('never lists a disabled provider, even when nothing else is on', () => {
    assert.deepEqual(pickerProvidersForCompany(providers.map((p) => ({ ...p, enabledForCompany: false }))), []);
  });

  it('returns id, name and type only (no URL or key flags)', () => {
    for (const p of pickerProvidersForCompany(providers)) {
      assert.deepEqual(Object.keys(p).sort(), ['id', 'name', 'type']);
    }
  });
});

describe('CHAT-5 parseThreadModelChoice', () => {
  it('accepts a valid choice, with or without effort', () => {
    assert.deepEqual(parseThreadModelChoice({ providerId: 'p1', modelId: 'org/model:7b' }), {
      providerId: 'p1',
      modelId: 'org/model:7b',
    });
    assert.deepEqual(parseThreadModelChoice({ providerId: 'p1', modelId: 'm', reasoningLevel: 'high' }), {
      providerId: 'p1',
      modelId: 'm',
      reasoningLevel: 'high',
    });
    assert.deepEqual(parseThreadModelChoice({ providerId: 'p1', modelId: 'm', reasoningLevel: null }), {
      providerId: 'p1',
      modelId: 'm',
    });
  });

  it('rejects missing, malformed or oversized values', () => {
    for (const raw of [
      null,
      undefined,
      'p1/m',
      [],
      {},
      { providerId: 'p1' },
      { modelId: 'm' },
      { providerId: 'p 1', modelId: 'm' },
      { providerId: 'p1', modelId: 'has space' },
      { providerId: 'p1', modelId: 'line\nbreak' },
      { providerId: 'p1', modelId: 'x'.repeat(201) },
      { providerId: 'p'.repeat(101), modelId: 'm' },
      { providerId: 'p1', modelId: 'm', reasoningLevel: 'ultra' },
      { providerId: 1, modelId: 'm' },
    ]) {
      assert.equal(parseThreadModelChoice(raw), null, JSON.stringify(raw));
    }
  });

  it('reads the choice from thread metadata; the key is reserved (not a tag)', () => {
    assert.equal(ASSISTANT_THREAD_MODEL_KEY, ASSISTANT_THREAD_MODEL_METADATA_KEY);
    assert.ok(ASSISTANT_THREAD_METADATA_KEYS.includes(ASSISTANT_THREAD_MODEL_KEY));
    assert.deepEqual(threadModelChoiceFromMetadata({ agentId: 'a', assistantModel: { providerId: 'p', modelId: 'm' } }), {
      providerId: 'p',
      modelId: 'm',
    });
    assert.equal(threadModelChoiceFromMetadata({ agentId: 'a' }), null);
    assert.equal(threadModelChoiceFromMetadata(undefined), null);
  });
});

describe('CHAT-5 effort levels', () => {
  it("uses the provider's reported levels first", () => {
    assert.deepEqual(effortLevelsForModel('local-model', { supported: true, allowedLevels: ['none', 'high'] }), ['none', 'high']);
  });

  it('falls back to the shared heuristic; unsupported models get none (effort hidden)', () => {
    assert.deepEqual(effortLevelsForModel('openai/gpt-5'), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    assert.deepEqual(effortLevelsForModel('llama-3.1-8b'), []);
    assert.deepEqual(effortLevelsForModel('llama-3.1-8b', { supported: false, allowedLevels: [] }), []);
    assert.deepEqual(effortLevelsForModel(''), []);
    assert.deepEqual(effortLevelsForModel(null), []);
  });

  it('keeps a level only when the model allows it', () => {
    assert.equal(effortForModel('high', ['none', 'high']), 'high');
    assert.equal(effortForModel('xhigh', ['none', 'high']), undefined);
    assert.equal(effortForModel(undefined, ['none']), undefined);
  });
});
