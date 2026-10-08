/**
 * Known placeholder / default secret values (shipped in .env.example, docs, or old code).
 *
 * Pure module with no imports so lib/board-auth.ts and lib/require-secret.ts can both use it
 * without an import cycle.
 */
export const KNOWN_PLACEHOLDER_SECRETS: ReadonlySet<string> = new Set([
  'change-me-in-production',
  'change-me-in-production-use-openssl-rand-base64-32',
  '<generate with: openssl rand -base64 32>',
]);

/**
 * True for a known placeholder, or anything that is plainly a template value
 * (`change-me…`, `<…>`, or text telling the reader to run `openssl rand`).
 * Expects an already-trimmed, non-empty value.
 */
export function isPlaceholderSecret(value: string): boolean {
  if (KNOWN_PLACEHOLDER_SECRETS.has(value)) return true;
  const lower = value.toLowerCase();
  if (lower.startsWith('change-me') || lower.startsWith('changeme')) return true;
  if (value.startsWith('<') && value.endsWith('>')) return true;
  return lower.includes('openssl rand');
}
