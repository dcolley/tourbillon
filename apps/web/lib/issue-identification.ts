/**
 * Pure helpers for issue URL resolution (issue #286): a route param is either
 * the issue's uuid primary key or its human identifier (e.g. `TOUR-590`).
 * Kept DB-free so it is unit-testable without a database connection.
 */

const ISSUE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Matches `${issuePrefix}-${counter}` as stamped at creation (see createCompany:
// issuePrefix is validated /^[A-Z0-9]+$/).
const ISSUE_IDENTIFIER_RE = /^[A-Z0-9]+-\d+$/;

export function isIssueUuid(input: string): boolean {
  return ISSUE_UUID_RE.test(input);
}

export function isIssueIdentifier(input: string): boolean {
  return ISSUE_IDENTIFIER_RE.test(input);
}

/**
 * When an identifier matches issues in more than one company (no unique
 * constraint on `identifier` or `issuePrefix`), prefer the active company;
 * otherwise fall back to a deterministic pick (earliest createdAt, then id).
 */
export function pickIssueCandidate<T extends { id: string; companyId: string; createdAt?: Date | null }>(
  candidates: T[],
  activeCompanyId?: string | null,
): T | null {
  if (candidates.length === 0) return null;
  if (activeCompanyId) {
    const active = candidates.find((c) => c.companyId === activeCompanyId);
    if (active) return active;
  }
  return [...candidates].sort((a, b) => {
    const aTime = a.createdAt?.getTime() ?? 0;
    const bTime = b.createdAt?.getTime() ?? 0;
    if (aTime !== bTime) return aTime - bTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}
