import { mergeCompanySettings } from '@tourbillon/shared/company-settings';
import type { AgentModelSettings } from '@tourbillon/shared/model-settings';
import type { CompanySettings } from '@tourbillon/shared/types';

export function slugifyCompanySlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function deriveIssuePrefix(name: string): string {
  const cleaned = name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
  return cleaned || 'CO';
}

/**
 * CONCIERGE-PARAMS S1 (gate #195): the settings write for the concierge pair — persistence of
 * `params` included (it survived earlier gates untested). Pure (no DB): updateCompanyConciergeModel
 * keeps the provider-availability guard and calls this for the merge. Empty providerId or modelId
 * clears the whole pair; a stored pair always carries params through untouched.
 */
export function mergeConciergeModelSettings(
  currentSettings: unknown,
  input: { providerId?: string; modelId?: string; params?: AgentModelSettings },
): CompanySettings {
  const providerId = input.providerId?.trim();
  const modelId = input.modelId?.trim();
  return mergeCompanySettings(currentSettings, {
    conciergeModel: providerId && modelId ? { providerId, modelId, params: input.params } : {},
  });
}
