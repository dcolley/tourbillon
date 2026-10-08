/**
 * Chat error mapping: an env credential host refusal becomes a 409 with its code.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EnvCredentialHostError } from '@tourbillon/shared';
import { chatErrorResponse } from './route-helpers';

describe('chatErrorResponse env credential host', () => {
  it('maps EnvCredentialHostError to 409 + code', async () => {
    const err = new EnvCredentialHostError(
      'The agent\'s base URL (https://evil.example) is on a different host from the OpenAI base URL configured in the server environment (expected https://api.openai.com); refusing to attach the API key from OPENAI_API_KEY there.',
      'llm_provider_base_url_host_mismatch',
    );
    const res = chatErrorResponse(err);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'llm_provider_base_url_host_mismatch');
    assert.match(body.error, /OPENAI_API_KEY/);
    assert.doesNotMatch(body.error, /sk-/);
  });
});
