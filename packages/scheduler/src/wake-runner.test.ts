import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { durableWakeOutcomeFromTripwire } from './durable-wake-outcome';

describe('durableWakeOutcomeFromTripwire', () => {
  it('returns recordSuccess false on Mastra tripwire with full metadata', () => {
    const tripwireData = {
      reason: 'TokenLimiterProcessor: System messages alone exceed token limit. Requests cannot be completed by removing system messages.',
      options: {
        metadata: {
          systemTokens: 150000,
          limit: 120000,
        },
      },
    };
    
    const outcome = durableWakeOutcomeFromTripwire(tripwireData);
    
    // This test FAILS if recordHeartbeatSuccess would still run
    assert.equal(outcome.recordSuccess, false, 'Must not record success on tripwire');
    
    if (!outcome.recordSuccess) {
      assert.equal(
        outcome.errorText,
        'System messages are 150000 tokens (limit 120000). Cannot trim further.',
        'Error text must include N and M from metadata'
      );
    }
  });

  it('returns recordSuccess false on tripwire with partial metadata', () => {
    const tripwireData = {
      reason: 'System messages alone exceed token limit',
      options: {
        metadata: {
          systemTokens: 95000,
        },
      },
    };
    
    const outcome = durableWakeOutcomeFromTripwire(tripwireData);
    
    assert.equal(outcome.recordSuccess, false, 'Must not record success on tripwire');
    
    if (!outcome.recordSuccess) {
      assert.equal(
        outcome.errorText,
        'System messages are 95000 tokens. Cannot trim further.',
        'Error text must include N from metadata'
      );
    }
  });

  it('returns recordSuccess false on tripwire with no metadata', () => {
    const tripwireData = {
      reason: 'System messages alone exceed token limit',
    };
    
    const outcome = durableWakeOutcomeFromTripwire(tripwireData);
    
    assert.equal(outcome.recordSuccess, false, 'Must not record success on tripwire');
    
    if (!outcome.recordSuccess) {
      assert.equal(
        outcome.errorText,
        'System messages alone exceed token limit. Cannot trim further.',
        'Error text must use fallback format'
      );
    }
  });

  it('returns recordSuccess true when no tripwire (successful trim)', () => {
    const noTripwireData = undefined;
    
    const outcome = durableWakeOutcomeFromTripwire(noTripwireData);
    
    assert.equal(outcome.recordSuccess, true, 'Must record success when no tripwire');
  });

  it('returns recordSuccess true on null tripwire', () => {
    const outcome = durableWakeOutcomeFromTripwire(null);
    
    assert.equal(outcome.recordSuccess, true, 'Must record success on null tripwire');
  });

  it('returns recordSuccess true on non-tripwire data', () => {
    const normalData = {
      someOtherField: 'normal operation',
    };
    
    const outcome = durableWakeOutcomeFromTripwire(normalData);
    
    assert.equal(outcome.recordSuccess, true, 'Must record success on non-tripwire data');
  });
});
