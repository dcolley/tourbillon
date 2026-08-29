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

describe('mapExportedSpanToEvent', () => {
  it('preserves AI_APICallError fields in payload.errorInfo', () => {
    const event = mapExportedSpanToEvent(
      span({
        errorInfo: {
          message: 'OpenAI stream failed before any output was generated',
          name: 'AI_APICallError',
          stack: 'Error: ...',
          statusCode: 400,
          url: 'http://192.168.10.199:1234/v1/chat/completions',
          responseBody: '{"error":{"message":"Maximum context length exceeded"}}',
          data: {
            error: {
              message: 'Maximum context length exceeded',
              type: 'invalid_request_error',
            },
          },
        } as any,
        requestContext: { get: () => 'company-1' },
      })
    );

    assert.ok(event);
    assert.equal(event.status, 'error');

    const payload = event.payload as Record<string, unknown>;
    const errorInfo = payload.errorInfo as Record<string, unknown>;

    // Verify all AI_APICallError fields are preserved
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
          statusCode: 500,
          responseBody: longBody,
        } as any,
        requestContext: { get: () => 'company-1' },
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
        requestContext: { get: () => 'company-1' },
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
