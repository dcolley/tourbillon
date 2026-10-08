/**
 * Agent detail page display path: omit-key on env host mismatch (never throw / never leak key).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resolveModelProviderConfig } from '@tourbillon/shared';
import { modelProviderOverridesFromAgent } from '@tourbillon/shared';

const ENV_KEYS = [
  'LLM_PROVIDER', 'LLM_BASE_URL', 'OPENAI_BASE_URL', 'LM_STUDIO_BASE_URL', 'OLLAMA_BASE_URL',
  'LLM_API_KEY', 'OPENAI_API_KEY', 'LM_STUDIO_API_KEY', 'OLLAMA_API_KEY', 'LLM_API_MODE',
] as const;
const saved: Record<string, string | undefined> = {};

const here = dirname(fileURLToPath(import.meta.url));
const agentPagePath = join(here, '../app/(dashboard)/agent/[urlKey]/page.tsx');

describe('agent detail page env credential host (display)', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('page wires onEnvCredentialHostMismatch: omit-key (not throw)', () => {
    // W4 mutant flips omit-key → throw; keep the display path soft.
    const src = readFileSync(agentPagePath, 'utf8');
    assert.match(src, /onEnvCredentialHostMismatch:\s*'omit-key'/);
    assert.doesNotMatch(src, /onEnvCredentialHostMismatch:\s*'throw'/);
  });

  it('page resolve path: mismatched agent omits the env key and does not throw', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-env-page-detail-key';
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
    // Same call shape as apps/web/app/(dashboard)/agent/[urlKey]/page.tsx.
    const config = resolveModelProviderConfig(
      modelProviderOverridesFromAgent('openai', { baseURL: 'https://evil.example/v1' }),
      null,
      null,
      { onEnvCredentialHostMismatch: 'omit-key' },
    );
    assert.equal(config.apiKey, '');
    assert.equal(config.baseURL, 'https://evil.example/v1');
    assert.doesNotMatch(JSON.stringify(config), /sk-env-page-detail/);
  });
});
