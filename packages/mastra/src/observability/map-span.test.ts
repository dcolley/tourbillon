import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import type { AnyExportedSpan } from '@mastra/core/observability';
import { mapExportedSpanToEvent } from './map-span';
import { resolveSpanErrorText } from './resolve-span-error-text';
import { 
  storeApiErrorDetailsByRequestKey, 
  clearAllApiErrorDetails,
  consumeApiErrorDetailsByRequestKey 
} from './error-details-registry';

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
  beforeEach(() => {
    clearAllApiErrorDetails();
  });

  it('store-then-export: errorText is enriched when error details stored BEFORE SPAN_ENDED', () => {
    const requestKey = 'test-request-key-123';
    
    // 1. Fetch wrapper stores error details by requestKey (BEFORE SPAN_ENDED)
    storeApiErrorDetailsByRequestKey(requestKey, {
      statusCode: 400,
      url: 'http://192.168.10.199:1234/v1/chat/completions',
      responseBody: '{"error":{"message":"Maximum context length exceeded"}}',
      data: {
        error: {
          message: 'Maximum context length exceeded',
          type: 'invalid_request_error',
        },
      },
    });
    
    // 2. Mastra creates span with only message/name/stack in errorInfo
    const testSpan = span({
      errorInfo: {
        message: 'OpenAI stream failed before any output was generated',
        name: 'AI_APICallError',
        stack: 'Error: ...',
        __firstFrameRequestKey: requestKey, // Attached by fetch wrapper
      } as any,
      metadata: {
        heartbeatRunId: 'run-123',
        companyId: 'company-1',
      },
    });

    // 3. Exporter enriches errorInfo (simulated by manually enriching like the exporter does)
    const details = consumeApiErrorDetailsByRequestKey(requestKey);
    assert.ok(details, 'Error details must be in registry before SPAN_ENDED');
    
    const enrichedErrorInfo = testSpan.errorInfo as Record<string, unknown>;
    if (details.statusCode !== undefined) enrichedErrorInfo.statusCode = details.statusCode;
    if (details.url !== undefined) enrichedErrorInfo.url = details.url;
    if (details.responseBody !== undefined) enrichedErrorInfo.responseBody = details.responseBody;
    if (details.data !== undefined) enrichedErrorInfo.data = details.data;

    // 4. Map the enriched span
    const event = mapExportedSpanToEvent(testSpan);

    assert.ok(event);
    assert.equal(event.status, 'error');

    const payload = event.payload as Record<string, unknown>;
    const errorInfo = payload.errorInfo as Record<string, unknown>;

    // Verify all AI_APICallError fields are in the payload
    assert.equal(errorInfo.message, 'OpenAI stream failed before any output was generated');
    assert.equal(errorInfo.name, 'AI_APICallError');
    assert.equal(errorInfo.statusCode, 400);
    assert.equal(errorInfo.url, 'http://192.168.10.199:1234/v1/chat/completions');
    assert.ok(errorInfo.responseBody);
    assert.ok(errorInfo.data);
    
    // CRITICAL: errorText must be enriched with HTTP status, URL, and provider message
    assert.ok(event.errorText);
    const hasHttpStatus = event.errorText.includes('HTTP 400') || event.errorText.includes('400');
    const hasProviderMessage = event.errorText.includes('Maximum context length exceeded');
    const hasUrl = event.errorText.includes('192.168.10.199') || event.errorText.includes('/v1/chat/completions');
    
    assert.ok(hasHttpStatus || hasProviderMessage || hasUrl, 
      `errorText must include HTTP status, URL, or provider message. Got: ${event.errorText}`);
    
    // Must NOT be just the SDK fallback
    assert.notEqual(event.errorText, 'OpenAI stream failed before any output was generated', 
      'errorText must be enriched, not just the SDK fallback');
  });

  it('no store: errorText is SDK fallback when error details NOT stored', () => {
    // No store call - registry is empty
    
    // Mastra creates span with only message/name/stack
    const testSpan = span({
      errorInfo: {
        message: 'OpenAI stream failed before any output was generated',
        name: 'AI_APICallError',
        stack: 'Error: ...',
      } as any,
      metadata: {
        companyId: 'company-1',
      },
    });

    // Exporter tries to enrich but finds nothing (registry is empty)
    // So errorInfo stays message-only
    
    const event = mapExportedSpanToEvent(testSpan);

    assert.ok(event);
    assert.equal(event.status, 'error');
    
    // errorText should be the SDK fallback because errorInfo was not enriched
    assert.equal(event.errorText, 'OpenAI stream failed before any output was generated',
      'When no error details stored, errorText must remain the SDK fallback');
  });

  it('caps very long responseBody in errorInfo', () => {
    const longBody = 'x'.repeat(3000);
    const requestKey = 'test-long-body';
    
    storeApiErrorDetailsByRequestKey(requestKey, {
      statusCode: 500,
      responseBody: longBody,
    });
    
    const testSpan = span({
      errorInfo: {
        message: 'Error',
        __firstFrameRequestKey: requestKey,
      } as any,
      metadata: { companyId: 'company-1' },
    });
    
    // Enrich
    const details = consumeApiErrorDetailsByRequestKey(requestKey);
    if (details?.responseBody) {
      (testSpan.errorInfo as Record<string, unknown>).responseBody = details.responseBody;
    }

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
