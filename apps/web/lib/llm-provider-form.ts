/**
 * #125 S5: API key part of the provider settings save payload.
 * - A typed key is sent (trimmed).
 * - "Clear stored API key" on an existing provider sends `clearApiKey: true` and no key, so a
 *   keyed provider can move to a keyless host from the UI (the host-change 409 says "or clear it").
 * - Blank and not cleared: nothing is sent, so the stored key is kept.
 */
export function apiKeySavePayload(
  form: { apiKey: string; clearApiKey: boolean },
  isNew: boolean,
): { apiKey?: string; clearApiKey?: true } {
  if (form.clearApiKey && !isNew) return { clearApiKey: true };
  const key = form.apiKey.trim();
  return key ? { apiKey: key } : {};
}
