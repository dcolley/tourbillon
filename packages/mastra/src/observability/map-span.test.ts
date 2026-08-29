import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AnyExportedSpan } from '@mastra/core/observability';
import { mapExportedSpanToEvent } from './map-span';
import { resolveSpanErrorText } from './resolve-span-error-text';

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
  it('preserves AI_APICallError fields in payload.errorInfo when enriched by exporter', () => {
    // Simulate the real timing: Mastra creates errorInfo with only message/name/stack
    const testSpan = span({
      errorInfo: {
        message: 'OpenAI stream failed before any output was generated',
        name: 'AI_APICallError',
        stack: 'Error: ...',
      } as any,
      metadata: {
        heartbeatRunId: 'run-123',
        companyId: 'company-1',
      },
    });

    // Simulate exporter enrichment (this happens in tourbillon-postgres-exporter before mapping)
    const enrichedErrorInfo = testSpan.errorInfo as Record<string, unknown>;
    enrichedErrorInfo.statusCode = 400;
    enrichedErrorInfo.url = 'http://192.168.10.199:1234/v1/chat/completions';
    enrichedErrorInfo.responseBody = '{"error":{"message":"Maximum context length exceeded"}}';
    enrichedErrorInfo.data = {
      error: {
        message: 'Maximum context length exceeded',
        type: 'invalid_request_error',
      },
    };

    // Now map the enriched span
    const event = mapExportedSpanToEvent(testSpan);

    assert.ok(event);
    assert.equal(event.status, 'error');

    const payload = event.payload as Record<string, unknown>;
    const errorInfo = payload.errorInfo as Record<string, unknown>;

    // Verify all AI_APICallError fields are preserved in the payload
    assert.equal(errorInfo.message, 'OpenAI stream failed before any output was generated');
    assert.equal(errorInfo.name, 'AI_APICallError');
    assert.equal(errorInfo.statusCode, 400);
    assert.equal(errorInfo.url, 'http://192.168.10.199:1234/v1/chat/completions');
    assert.ok(errorInfo.responseBody);
    assert.ok(errorInfo.data);
    
    // CRITICAL: errorText must be enriched, not the SDK fallback
    assert.ok(event.errorText);
    assert.ok(event.errorText.includes('Maximum context length exceeded') || event.errorText.includes('HTTP 400'));
    assert.notEqual(event.errorText, 'OpenAI stream failed before any output was generated', 
      'errorText must be enriched with provider details, not just the SDK fallback');
  });

  it('errorText enrichment fails if errorInfo is not enriched by exporter', () => {
    // This test proves the exporter enrichment is essential
    const testSpan = span({
      errorInfo: {
        message: 'OpenAI stream failed before any output was generated',
        name: 'AI_APICallError',
        stack: 'Error: ...',
        // NO enrichment - statusCode/url/responseBody missing
      } as any,
      metadata: {
        companyId: 'company-1',
      },
    });

    const event = mapExportedSpanToEvent(testSpan);

    assert.ok(event);
    assert.equal(event.status, 'error');
    
    // errorText should be the SDK fallback because errorInfo was not enriched
    assert.equal(event.errorText, 'OpenAI stream failed before any output was generated');
  });

  it('caps very long responseBody in errorInfo', () => {
    const longBody = 'x'.repeat(3000);
    const testSpan = span({
      errorInfo: {
        message: 'Error',
        responseBody: longBody,
      } as any,
      metadata: { companyId: 'company-1' },
    });

    const event = mapExportedSpanToEvent(testSpan);

    assert.ok(event);
    const payload = event.payload as Record<string, unknown>;
    const errorInfo = payload.errorInfo as Record<string, unknown>;
    const cappedBody = errorInfo.responseBody as string;

    assert.ok(cappedBody);
    assert.ok(cappedBody.length < longBody.length);
    assert.ok(cappedBody.includes('truncated'));
  });

  it('preserves errorInfo without API error fields', () => {
    const testSpan = span({
      errorInfo: {
        message: 'Generic error',
        name: 'Error',
        stack: 'Error: ...',
      } as any,
      metadata: { companyId: 'company-1' },
    });

    const event = mapExportedSpanToEvent(testSpan);

    assert.ok(event);
    const payload = event.payload as Record<string, unknown>;
    const errorInfo = payload.errorInfo as Record<string, unknown>;

    assert.equal(errorInfo.message, 'Generic error');
    assert.equal(errorInfo.name, 'Error');
    assert.ok(errorInfo.stack);
  });
});
