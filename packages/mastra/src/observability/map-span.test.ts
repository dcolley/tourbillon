import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import type { AnyExportedSpan } from '@mastra/core/observability';
import { mapExportedSpanToEvent } from './map-span';
import { resolveSpanErrorText } from './resolve-span-error-text';
import { 
  storeApiErrorDetails,
  storeApiErrorDetailsByRequestKey,
  clearAllApiErrorDetails,
  consumeApiErrorDetails 
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

  it('store-then-export: errorText enriched when stored by runId BEFORE SPAN_ENDED', () => {
    const runId = 'run-123';
    
    // 1. Wake-runner stores error details by runId (after transferring from fetch wrapper)
    storeApiErrorDetails(runId, {
      statusCode: 400,
      url: 'http://192.168.10.199:1234/v1/chat/completions',
      responseBody: '{"error":{"message":"Maximum context length exceeded"}}',
      data: {
        error: {
          message: 'Maximum context length exceeded',
          type: 'invalid_request_error',
        },
      },
      firstFrameRequestKey: 'test-request-key',
    });
    
    // 2. Mastra creates span with ONLY message/name/stack in errorInfo (real Mastra behavior)
    //    NO __firstFrameRequestKey - Mastra doesn't copy it
    const testSpan = span({
      errorInfo: {
        message: 'OpenAI stream failed before any output was generated',
        name: 'AI_APICallError',
        stack: 'Error: ...',
        // NO __firstFrameRequestKey here - Mastra doesn't copy non-standard fields
      } as any,
      metadata: {
        heartbeatRunId: runId,
        companyId: 'company-1',
      },
    });

    // 3. Exporter enriches errorInfo by looking up runId (simulated)
    const details = consumeApiErrorDetails(runId);
    assert.ok(details, 'Error details must be in registry with runId');
    
    const enrichedErrorInfo = testSpan.errorInfo as Record<string, unknown>;
    if (details.statusCode !== undefined) enrichedErrorInfo.statusCode = details.statusCode;
    if (details.url !== undefined) enrichedErrorInfo.url = details.url;
    if (details.responseBody !== undefined) enrichedErrorInfo.responseBody = details.responseBody;
    if (details.data !== undefined) enrichedErrorInfo.data = details.data;
    if (details.firstFrameRequestKey !== undefined) enrichedErrorInfo.__firstFrameRequestKey = details.firstFrameRequestKey;

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

  it('store-by-pattern-then-export: 200 + reasoning_content first frame + SDK throw enriches errorText', () => {
    // Nemotron case: HTTP 200, first frame is reasoning_content (non-error), SDK throws later
    // Fetch wrapper stores by requestKey + runId (from AsyncLocalStorage) BEFORE SPAN_ENDED
    // Exporter uses runId-based lookup at SPAN_ENDED
    
    const runId = 'run-reasoning-test';
    const requestKey = 'req-reasoning-test';
    
    // 1. Fetch wrapper stores by requestKey + runId when peek completes (200 + reasoning_content)
    //    In production, companyId/agentId are NOT passed to storeApiErrorDetailsByRequestKey
    //    Only runId is passed (from AsyncLocalStorage)
    storeApiErrorDetailsByRequestKey(
      requestKey,
      {
        statusCode: 200,
        url: 'http://lmstudio:1234/v1/chat/completions',
        responseBody: 'First frame: reasoning_content | {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}',
        data: { choices: [{ delta: { reasoning_content: 'thinking...' } }] },
      },
      runId // Only runId is passed, matching production behavior
    );
    
    // 2. SDK throws later, Mastra creates span with message/name/stack only (no __firstFrameRequestKey)
    const testSpan = span({
      errorInfo: {
        message: 'OpenAI stream failed before any output was generated',
        name: 'AI_APICallError',
        stack: 'Error: OpenAI stream failed...',
        // NO __firstFrameRequestKey - Mastra doesn't copy it
      } as any,
      metadata: {
        companyId: 'company-123', // Required for mapExportedSpanToEvent
        heartbeatRunId: runId, // Exporter uses this to look up error details
      },
    });
    
    // 3. SPAN_ENDED fires - exporter enriches using runId lookup (simulated)
    const details = consumeApiErrorDetails(runId);
    assert.ok(details, 'Error details must be in registry via runId lookup');
    
    const enrichedErrorInfo = testSpan.errorInfo as Record<string, unknown>;
    if (details.statusCode !== undefined) enrichedErrorInfo.statusCode = details.statusCode;
    if (details.url !== undefined) enrichedErrorInfo.url = details.url;
    if (details.responseBody !== undefined) enrichedErrorInfo.responseBody = details.responseBody;
    if (details.data !== undefined) enrichedErrorInfo.data = details.data;
    if (details.firstFrameRequestKey !== undefined) enrichedErrorInfo.__firstFrameRequestKey = details.firstFrameRequestKey;
    
    // 4. Map the enriched span
    const event = mapExportedSpanToEvent(testSpan);
    
    assert.ok(event);
    assert.equal(event.status, 'error');

    const payload = event.payload as Record<string, unknown>;
    const errorInfo = payload.errorInfo as Record<string, unknown>;
    
    // Verify all AI_APICallError fields are in the payload
    assert.equal(errorInfo.statusCode, 200);
    assert.ok(errorInfo.url?.toString().includes('lmstudio'), 'payload errorInfo.url missing lmstudio');
    assert.ok(errorInfo.responseBody?.toString().includes('reasoning_content'), 'payload errorInfo.responseBody missing reasoning_content');
    
    // CRITICAL: errorText must be enriched with HTTP status, URL, and first frame excerpt
    assert.ok(event.errorText);
    
    // errorText must NOT be the SDK fallback
    assert.notEqual(event.errorText, 'OpenAI stream failed before any output was generated');
    
    // errorText must include HTTP 200, URL, and first frame excerpt
    assert.ok(event.errorText?.includes('200'), 'errorText missing status 200');
    assert.ok(event.errorText?.includes('lmstudio'), 'errorText missing URL host');
    assert.ok(event.errorText?.includes('reasoning_content'), 'errorText missing first frame kind');
  });

  it('no store: errorText is SDK fallback when error details NOT stored', () => {
    // No store call - registry is empty
    
    // Mastra creates span with only message/name/stack (real Mastra shape)
    const testSpan = span({
      errorInfo: {
        message: 'OpenAI stream failed before any output was generated',
        name: 'AI_APICallError',
        stack: 'Error: ...',
      } as any,
      metadata: {
        heartbeatRunId: 'run-456',
        companyId: 'company-1',
      },
    });

    // Exporter tries to enrich but registry is empty (no lookup succeeds)
    const details = consumeApiErrorDetails('run-456');
    assert.equal(details, undefined, 'Registry should be empty');
    
    const event = mapExportedSpanToEvent(testSpan);

    assert.ok(event);
    assert.equal(event.status, 'error');
    
    // errorText should be the SDK fallback because errorInfo was not enriched
    assert.equal(event.errorText, 'OpenAI stream failed before any output was generated',
      'When no error details stored, errorText must remain the SDK fallback');
  });

  it('caps very long responseBody in errorInfo', () => {
    const longBody = 'x'.repeat(3000);
    const runId = 'run-789';
    
    storeApiErrorDetails(runId, {
      statusCode: 500,
      responseBody: longBody,
      url: undefined,
      data: undefined,
      firstFrameRequestKey: undefined,
    });
    
    const testSpan = span({
      errorInfo: {
        message: 'Error',
      } as any,
      metadata: { 
        heartbeatRunId: runId,
        companyId: 'company-1' 
      },
    });
    
    // Enrich
    const details = consumeApiErrorDetails(runId);
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
      metadata: { 
        heartbeatRunId: 'run-generic',
        companyId: 'company-1' 
      },
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
