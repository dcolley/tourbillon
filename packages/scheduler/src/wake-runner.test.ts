import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSystemMessageTripwire, extractTripwireTokenCounts, formatSystemMessageTripwireError } from '@tourbillon/shared';

describe('wake tripwire handling', () => {
  it('detects tripwire from output.tripwire with options.metadata', () => {
    const tripwireData = {
      reason: 'TokenLimiterProcessor: System messages alone exceed token limit. Requests cannot be completed by removing system messages.',
      options: {
        metadata: {
          systemTokens: 150000,
          limit: 120000,
        },
      },
    };
    
    assert.equal(isSystemMessageTripwire(tripwireData), true);
    
    const counts = extractTripwireTokenCounts(tripwireData);
    assert.equal(counts.systemTokens, 150000);
    assert.equal(counts.limit, 120000);
    
    const errorText = formatSystemMessageTripwireError(counts.systemTokens, counts.limit);
    assert.equal(errorText, 'System messages are 150000 tokens (limit 120000). Cannot trim further.');
  });

  it('detects tripwire with partial metadata', () => {
    const tripwireData = {
      reason: 'System messages alone exceed token limit',
      options: {
        metadata: {
          systemTokens: 95000,
        },
      },
    };
    
    const counts = extractTripwireTokenCounts(tripwireData);
    assert.equal(counts.systemTokens, 95000);
    assert.equal(counts.limit, undefined);
    
    const errorText = formatSystemMessageTripwireError(counts.systemTokens, counts.limit);
    assert.equal(errorText, 'System messages are 95000 tokens. Cannot trim further.');
  });

  it('formats error with no metadata', () => {
    const tripwireData = {
      reason: 'System messages alone exceed token limit',
    };
    
    const counts = extractTripwireTokenCounts(tripwireData);
    const errorText = formatSystemMessageTripwireError(counts.systemTokens, counts.limit);
    assert.equal(errorText, 'System messages alone exceed token limit. Cannot trim further.');
  });
});
