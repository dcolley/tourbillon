import {
  isSystemMessageTripwire,
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
 * Returns recordSuccess: false when TokenLimiter tripwire is detected
 * (system messages alone exceed token limit).
 */
export function durableWakeOutcomeFromTripwire(
  tripwireData: unknown
): DurableWakeOutcome {
  if (!tripwireData || !isSystemMessageTripwire(tripwireData)) {
    return { recordSuccess: true };
  }

  const counts = extractTripwireTokenCounts(tripwireData);
  const errorText = formatSystemMessageTripwireError(counts.systemTokens, counts.limit);

  return {
    recordSuccess: false,
    errorText,
  };
}
