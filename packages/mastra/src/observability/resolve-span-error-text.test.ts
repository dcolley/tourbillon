import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AnyExportedSpan } from '@mastra/core/observability';
import { resolveSpanErrorText } from './resolve-span-error-text';

function span(partial: Partial<AnyExportedSpan>): AnyExportedSpan {
  return partial as AnyExportedSpan;
}

describe('resolveSpanErrorText', () => {
  it('uses errorInfo.message when present', () => {
    const result = resolveSpanErrorText(
      span({ errorInfo: { message: '  Provider overloaded  ' } }),
    );
    assert.equal(result, 'Provider overloaded');
  });

  it('maps terminated message to friendly text', () => {
    const result = resolveSpanErrorText(
      span({ errorInfo: { message: 'terminated', name: 'TypeError' } }),
    );
    assert.equal(
      result,
      'Run terminated (abort, worker shutdown, or stall recovery)',
    );
  });

  it('enriches terminated output when message is empty', () => {
    const result = resolveSpanErrorText(
      span({ errorInfo: {}, output: 'terminated' }),
    );
    assert.equal(
      result,
      'Run terminated (abort, worker shutdown, or stall recovery)',
    );
  });

  it('uses attributes.finishReason when message is empty', () => {
    const result = resolveSpanErrorText(
      span({
        errorInfo: {},
        attributes: { finishReason: 'length' },
      }),
    );
    assert.equal(result, 'Run failed: length');
  });

  it('returns undefined when errorInfo is absent', () => {
    assert.equal(resolveSpanErrorText(span({})), undefined);
  });

  it('extracts structured error from AI_APICallError data.error.message', () => {
    const result = resolveSpanErrorText(
      span({
        errorInfo: {
          message: 'OpenAI stream failed before any output was generated',
          statusCode: 400,
          url: 'http://192.168.10.199:1234/v1/chat/completions',
          data: {
            error: {
              message: 'Maximum context length exceeded',
              type: 'invalid_request_error',
            },
          },
        },
      }),
    );
    assert.ok(result?.includes('Maximum context length exceeded'));
    assert.ok(result?.includes('HTTP 400'));
    assert.ok(result?.includes('192.168.10.199:1234/v1/chat/completions'));
  });

  it('extracts error from AI_APICallError responseBody JSON', () => {
    const result = resolveSpanErrorText(
      span({
        errorInfo: {
          message: 'OpenAI stream failed before any output was generated',
          statusCode: 500,
          url: 'http://localhost:1234/v1/chat/completions',
          responseBody: JSON.stringify({
            error: {
              message: 'Internal server error',
              type: 'server_error',
            },
          }),
        },
      }),
    );
    assert.ok(result?.includes('Internal server error'));
    assert.ok(result?.includes('HTTP 500'));
    assert.ok(result?.includes('localhost:1234/v1/chat/completions'));
  });

  it('includes capped responseBody when no structured error found', () => {
    const result = resolveSpanErrorText(
      span({
        errorInfo: {
          message: 'OpenAI stream failed before any output was generated',
          statusCode: 502,
          url: 'http://localhost:1234/v1/chat/completions',
          responseBody: 'Bad Gateway: upstream server timeout',
        },
      }),
    );
    assert.ok(result?.includes('OpenAI stream failed'));
    assert.ok(result?.includes('HTTP 502'));
    assert.ok(result?.includes('Bad Gateway'));
  });

  it('caps very long responseBody', () => {
    const longBody = 'x'.repeat(3000);
    const result = resolveSpanErrorText(
      span({
        errorInfo: {
          message: 'OpenAI stream failed before any output was generated',
          statusCode: 500,
          responseBody: longBody,
        },
      }),
    );
    assert.ok(result);
    assert.ok(result.length < longBody.length + 200);
    assert.ok(result.includes('…'));
  });
});
