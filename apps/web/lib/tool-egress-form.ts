import { splitToolEgressAllowListText } from '@tourbillon/shared';

/** Read the allow-list fields posted by ToolEgressAllowListFields. Validation happens on save. */
export function parseToolEgressFormData(formData: FormData): { mode: 'off' | 'list'; entries: string[] } {
  const mode = formData.get('toolEgressMode') === 'list' ? 'list' : 'off';
  return { mode, entries: splitToolEgressAllowListText(formData.get('toolEgressEntries')) };
}

export const TOOL_EGRESS_EMPTY_LIST_WARNING =
  'Warning: "Only these hosts" is saved with an empty list, so no outbound host is allowed for agent tools.';

/** Save confirmation; warns when "Only these hosts" was saved with no entries (fail-closed). */
export function toolEgressSavedMessage(saved: string[] | undefined): string {
  if (saved !== undefined && saved.length === 0) {
    return `Outbound host allow-list saved. ${TOOL_EGRESS_EMPTY_LIST_WARNING}`;
  }
  return 'Outbound host allow-list saved.';
}
