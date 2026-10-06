/**
 * Operator-facing copy for sandbox egress LAN blocking.
 * Keep in sync with `packages/mastra/src/egress-private-ranges.ts`.
 */

export const EGRESS_PRIVATE_RANGES_HELP =
  'Private ranges are blocked unless listed explicitly as an exact IP, a CIDR, or an exact hostname. Wildcards (*.domain) never allow a private IP. Cloud metadata (169.254.169.254) is never allowed.';

export const EGRESS_LAN_BLOCKING_NEEDS_BWRAP =
  'LAN blocking needs isolation=bwrap. isolation=none and seatbelt cannot enforce the egress proxy; legacy Allow network will warn per run and will not block localhost/LAN.';
