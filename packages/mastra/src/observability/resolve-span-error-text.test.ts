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
});
