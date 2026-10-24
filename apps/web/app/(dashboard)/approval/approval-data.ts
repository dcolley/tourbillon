/**
 * APR-2: data for the Board approval pages: lazy expiry, `presented` events and `/o/` link paths.
 * Everything is scoped to one company.
 */
import { BOARD_REVIEWER, hitlItemsOf, hitlRequestOf, linkPathsFor, recordReviewerEvent } from '@/lib/hitl-host';
import type { Approval } from '@tourbillon/db';

/** Record `presented` once per pending approval shown to the Board, and return its link paths. */
export async function prepareCardForBoard(companyId: string, approval: Approval): Promise<Record<string, string>> {
  if (approval.status !== 'pending') return {};
  try {
    if (!approval.presentedAt) {
      await recordReviewerEvent({ companyId, approvalId: approval.id, type: 'presented', actor: BOARD_REVIEWER });
    }
    const refs = hitlItemsOf(hitlRequestOf(approval)).map((i) => i.ref);
    return refs.length > 0 ? await linkPathsFor({ companyId, approvalId: approval.id, refs }) : {};
  } catch (err) {
    console.error('[approval-page] could not prepare approval card', approval.id, err instanceof Error ? err.message : 'error');
    return {};
  }
}
