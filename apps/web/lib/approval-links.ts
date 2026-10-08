/** Links to the approval details page (`/approval/[approvalId]`, singular like /issue and /agent). */
export function approvalDetailHref(approvalId: string): string {
  return `/approval/${encodeURIComponent(approvalId)}`;
}

/**
 * `/approval?id=<id>` (older search-result links) → `/approval/<id>`. Returns null when there is
 * no usable id, so the list renders as before. Only the path segment is built from the input.
 */
export function legacyApprovalRedirect(
  searchParams: Record<string, string | string[] | undefined> | undefined,
): string | null {
  const raw = searchParams?.id;
  const id = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!id || id.length > 128) return null;
  return approvalDetailHref(id);
}
