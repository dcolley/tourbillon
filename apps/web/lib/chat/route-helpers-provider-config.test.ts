/**
 * runs-follow-default: a chat request whose agent can't be built because its adapterConfig.baseURL
 * is on another host from its provider gets 409 { error, code: llm_provider_base_url_host_mismatch }
 * (same as /api/models), not a bare 500. '@/lib/company' and '@/lib/chat' are stubbed.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderConfigError } from '@tourbillon/shared';

describe('chatErrorResponse: ProviderConfigError', () => {
  let chatErrorResponse: (err: unknown) => Response;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (this?.filename?.endsWith('route-helpers.ts')) {
        if (id === '@/lib/company') return { ActiveCompanyError: class extends Error {} };
        if (id === '@/lib/chat') return { ChatAgentError: class extends Error {} };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ chatErrorResponse } = (await import('./route-helpers')) as unknown as { chatErrorResponse: typeof chatErrorResponse });
    Module.prototype.require = originalRequire;
  });

  it('host mismatch → 409 with the code and message', async () => {
    const res = chatErrorResponse(new ProviderConfigError('different host', 'llm_provider_base_url_host_mismatch'));
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'different host', code: 'llm_provider_base_url_host_mismatch' });
  });

  it('a copy of the error class from another bundle is recognised by shape', async () => {
    const foreign = Object.assign(new Error('different host'), {
      name: 'ProviderConfigError', code: 'llm_provider_base_url_host_mismatch', status: 409,
    });
    const res = chatErrorResponse(foreign);
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, 'llm_provider_base_url_host_mismatch');
  });

  it('other errors are unchanged (500)', async () => {
    const orig = console.error;
    console.error = () => {};
    try {
      assert.equal(chatErrorResponse(new Error('boom')).status, 500);
    } finally {
      console.error = orig;
    }
  });
});
