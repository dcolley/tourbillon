import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AnyExportedSpan } from '@mastra/core/observability';
import { mapExportedSpanToEvent } from './map-span';

function span(partial: Partial<AnyExportedSpan>): AnyExportedSpan {
  return {
    id: 'span-1',
    traceId: 'trace-1',
    type: 'model_generation' as any,
    name: 'test',
    startTime: new Date(),
    endTime: new Date(),
    ...partial,
  } as AnyExportedSpan;
}

function mockRequestContext(values: Record<string, unknown>): { get: (key: string) => unknown; set: (key: string, value: unknown) => void } {
  return {
    get: (key: string) => values[key],
    set: (key: string, value: unknown) => { values[key] = value; },
  };
}

describe('mapExportedSpanToEvent', () => {
  it('preserves AI_APICallError fields in payload.errorInfo', () => {
    const event = mapExportedSpanToEvent(
      span({
        errorInfo: {
          message: 'OpenAI stream failed before any output was generated',
          name: 'AI_APICallError',
          stack: 'Error: ...',
        } as any,
        requestContext: mockRequestContext({
          companyId: 'company-1',
          __errorStatusCode: 400,
          __errorUrl: 'http://192.168.10.199:1234/v1/chat/completions',
          __errorResponseBody: '{"error":{"message":"Maximum context length exceeded"}}',
          __errorData: {
            error: {
              message: 'Maximum context length exceeded',
              type: 'invalid_request_error',
            },
          },
        }),
      })
    );

    assert.ok(event);
    assert.equal(event.status, 'error');

    const payload = event.payload as Record<string, unknown>;
    const errorInfo = payload.errorInfo as Record<string, unknown>;

    // Verify all AI_APICallError fields are preserved from requestContext
    assert.equal(errorInfo.message, 'OpenAI stream failed before any output was generated');
    assert.equal(errorInfo.name, 'AI_APICallError');
    assert.equal(errorInfo.statusCode, 400);
    assert.equal(errorInfo.url, 'http://192.168.10.199:1234/v1/chat/completions');
    assert.ok(errorInfo.responseBody);
    assert.ok(errorInfo.data);
  });

  it('caps very long responseBody in errorInfo', () => {
    const longBody = 'x'.repeat(3000);
    const event = mapExportedSpanToEvent(
      span({
        errorInfo: {
          message: 'Error',
        } as any,
        requestContext: mockRequestContext({
          companyId: 'company-1',
          __errorStatusCode: 500,
          __errorResponseBody: longBody,
        }),
      })
    );

    assert.ok(event);
    const payload = event.payload as Record<string, unknown>;
    const errorInfo = payload.errorInfo as Record<string, unknown>;
    const cappedBody = errorInfo.responseBody as string;

    assert.ok(cappedBody);
    assert.ok(cappedBody.length < longBody.length);
    assert.ok(cappedBody.includes('truncated'));
  });

  it('preserves errorInfo without API error fields', () => {
    const event = mapExportedSpanToEvent(
      span({
        errorInfo: {
          message: 'Generic error',
          name: 'Error',
          stack: 'Error: ...',
        } as any,
        requestContext: mockRequestContext({ companyId: 'company-1' }),
      })
    );

    assert.ok(event);
    const payload = event.payload as Record<string, unknown>;
    const errorInfo = payload.errorInfo as Record<string, unknown>;

    assert.equal(errorInfo.message, 'Generic error');
    assert.equal(errorInfo.name, 'Error');
    assert.ok(errorInfo.stack);
  });
});
