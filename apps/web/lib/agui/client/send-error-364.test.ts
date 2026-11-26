/**
 * TB-364 SEED: error classification table (contract A17, A18, A24, A26, A37). Pure function, no I/O.
 * Module path/name are normative: apps/web/lib/agui/client/send-error.ts exporting
 *   classifySendError(input): { category, retryable, retryAfterMs?, friendly: { title, hint }, technical }
 * Red on base: module does not exist.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifySendError } from './send-error';

const LITELLM_500 =
  "litellm.InternalServerError: OpenAIException - Connection error. LiteLLM: model group 'spark1/inkling-2-mini' failed ... no fallback model group was found for it";

describe('TB-364 seed: classifySendError', () => {
  it('A17: transient = timeout, network drop, 5xx, 429 (with Retry-After honoured)', () => {
    for (const input of [
      { kind: 'run', message: LITELLM_500 },
      { kind: 'network', message: 'fetch failed' },
      { kind: 'http', status: 502, message: 'Bad gateway' },
      { kind: 'http', status: 503, message: 'Service unavailable' },
      { kind: 'http', status: 504, message: 'Gateway timeout' },
      { kind: 'run', message: 'litellm.Timeout: Connection timed out after 600 seconds' },
      { kind: 'run', message: 'litellm.RateLimitError: 429 Too Many Requests' },
    ]) {
      const c = classifySendError(input as never);
      assert.equal(c.retryable, true, JSON.stringify(input));
    }
    const rl = classifySendError({ kind: 'http', status: 429, message: 'rate limited', retryAfterSeconds: 7 } as never);
    assert.equal(rl.retryable, true);
    assert.equal(rl.retryAfterMs, 7000);
  });

  it('A18: permanent = 4xx auth / bad request / context length / model-not-found / policy; never retryable', () => {
    for (const input of [
      { kind: 'http', status: 401, message: 'Unauthorized' },
      { kind: 'http', status: 403, message: 'Forbidden' },
      { kind: 'http', status: 404, message: 'Not found' },
      { kind: 'http', status: 400, message: 'Bad request' },
      { kind: 'run', message: 'litellm.AuthenticationError: invalid api key' },
      { kind: 'run', message: "litellm.ContextWindowExceededError: This model's maximum context length is 8192 tokens" },
      { kind: 'run', message: 'litellm.NotFoundError: model not found' },
      { kind: 'run', message: 'litellm.ContentPolicyViolationError: blocked' },
      { kind: 'conflict', status: 409, message: 'A run is already in progress; send steer or followUp instead' },
    ]) {
      assert.equal(classifySendError(input as never).retryable, false, JSON.stringify(input));
    }
  });

  it('A18 (unknown row): an UNKNOWN error is not auto-retried (conservative default)', () => {
    assert.equal(classifySendError({ kind: 'run', message: 'something odd' } as never).retryable, false);
  });

  it('A24/A26 slice: friendly copy never contains the raw provider text; technical keeps it, with secrets redacted', () => {
    const c = classifySendError({
      kind: 'run',
      message: `${LITELLM_500} Authorization: Bearer sk-live-abcdef1234567890 api_key=sk-test-0123456789abcdef`,
    } as never);
    const friendly = `${c.friendly.title} ${c.friendly.hint}`;
    assert.ok(!/litellm|OpenAIException|spark1|inkling/i.test(friendly), friendly);
    assert.match(c.technical, /InternalServerError/);
    assert.ok(!/sk-live-abcdef1234567890|sk-test-0123456789abcdef/.test(c.technical), 'keys redacted');
    assert.ok(c.technical.length <= 2000, 'bounded');
  });

  it('A37: 401/403 friendly copy tells the user to sign in again; never retryable', () => {
    for (const status of [401, 403] as const) {
      const c = classifySendError({
        kind: 'http',
        status,
        message: status === 401 ? 'Unauthorized' : 'Forbidden',
      } as never);
      assert.equal(c.retryable, false, String(status));
      const friendly = `${c.friendly.title} ${c.friendly.hint}`;
      assert.match(friendly, /sign in|log in|re-auth|session/i, friendly);
    }
  });
});
