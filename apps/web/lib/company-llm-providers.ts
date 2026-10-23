/**
 * PRV-1: pure helpers for per-company provider enablement (no DB, safe in client bundles).
 * A provider is on for a company unless the company switched it off.
 */

export type WithCompanyEnablement<T> = T & { enabledForCompany: boolean };

/** Adds `enabledForCompany` to each provider (absent from `disabledIds` → on). */
export function markEnabledForCompany<T extends { id: string }>(
  providers: T[],
  disabledIds: ReadonlySet<string>,
): WithCompanyEnablement<T>[] {
  return providers.map((p) => ({ ...p, enabledForCompany: !disabledIds.has(p.id) }));
}

/** Suffix shown on a picker entry that is switched off but still selected. */
export const PROVIDER_OFF_SUFFIX = ' (off for this company)';

/**
 * Providers a company's pickers offer: those switched on. Current selections (`keep`)
 * stay listed even when off, labelled, so saving a form never silently changes them.
 */
export function providersForCompanyPicker<T extends { id: string; name: string; enabledForCompany: boolean }>(
  providers: T[],
  keep?: string | null | ReadonlyArray<string | null | undefined>,
): T[] {
  const keepIds = new Set(
    (typeof keep === 'string' || keep == null ? [keep] : keep).filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    ),
  );
  return providers
    .filter((p) => p.enabledForCompany || keepIds.has(p.id))
    .map((p) => (p.enabledForCompany ? p : { ...p, name: `${p.name}${PROVIDER_OFF_SUFFIX}` }));
}

/** Client call for the settings toggle. Throws with the server's message on failure. */
export async function setProviderEnabledForCompanyRequest(
  companyId: string,
  providerId: string,
  enabled: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<{ providerId: string; companyId: string; enabledForCompany: boolean }> {
  const res = await fetchImpl(
    `/api/companies/${encodeURIComponent(companyId)}/llm-providers/${encodeURIComponent(providerId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    },
  );
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    providerId?: string;
    companyId?: string;
    enabledForCompany?: boolean;
  };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return {
    providerId: data.providerId ?? providerId,
    companyId: data.companyId ?? companyId,
    enabledForCompany: data.enabledForCompany ?? enabled,
  };
}
