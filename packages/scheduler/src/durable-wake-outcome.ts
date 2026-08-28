import {
  isSystemMessageTripwire,
  isTokenLimiterTripwireInSpan,
  extractTripwireTokenCounts,
  formatSystemMessageTripwireError,
} from '@tourbillon/shared';

/**
 * Outcome of a durable agent wake based on tripwire detection.
 * When recordSuccess is false, the run must fail with errorText.
 */
export type DurableWakeOutcome =
  | { recordSuccess: true }
  | { recordSuccess: false; errorText: string };

/**
 * Determine whether a durable wake should record success or fail based on
 * tripwire data from output.tripwire.
 *
 * Returns recordSuccess: false when ANY TokenLimiter tripwire is detected
 * (not just system messages alone exceed).
 */
export function durableWakeOutcomeFromTripwire(
  tripwireData: unknown
): DurableWakeOutcome {
  if (!tripwireData || !isTokenLimiterTripwireInSpan(tripwireData)) {
    return { recordSuccess: true };
  }

  const counts = extractTripwireTokenCounts(tripwireData);
  
  // Format error text: prefer system-message-alone format when detected,
  // otherwise generic TokenLimiter error with any available counts
  let errorText: string;
  if (isSystemMessageTripwire(tripwireData)) {
    errorText = formatSystemMessageTripwireError(counts.systemTokens, counts.limit);
  } else {
    // Generic TokenLimiter tripwire
    const tripwireStr = typeof tripwireData === 'string' ? tripwireData : JSON.stringify(tripwireData);
    const reasonMatch = tripwireStr.match(/reason['":\s]+([^"'}]+)/i);
    const tripwireMatch = tripwireStr.match(/tripwire['":\s]+([^"'}]+)/i);
    const rawMessage = reasonMatch?.[1] || tripwireMatch?.[1] || 'TokenLimiter tripwire';
    
    if (counts.systemTokens !== undefined && counts.limit !== undefined) {
      errorText = `${rawMessage} (${counts.systemTokens} tokens, limit ${counts.limit})`;
    } else if (counts.systemTokens !== undefined) {
      errorText = `${rawMessage} (${counts.systemTokens} tokens)`;
    } else if (counts.limit !== undefined) {
      errorText = `${rawMessage} (limit ${counts.limit})`;
    } else {
      errorText = rawMessage;
    }
  }

  return {
    recordSuccess: false,
    errorText,
  };
}
