import { splitToolEgressAllowListText } from '@tourbillon/shared';

/** Read the allow-list fields posted by ToolEgressAllowListFields. Validation happens on save. */
export function parseToolEgressFormData(formData: FormData): { mode: 'off' | 'list'; entries: string[] } {
  const mode = formData.get('toolEgressMode') === 'list' ? 'list' : 'off';
  return { mode, entries: splitToolEgressAllowListText(formData.get('toolEgressEntries')) };
}
