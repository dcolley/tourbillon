/** Natural sort for issue IDs like XP-1, XP-2, XP-10 (prefix + numeric counter). */
export function compareIssueIdentifiers(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
