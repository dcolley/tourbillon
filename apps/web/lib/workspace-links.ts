/**
 * Resolve a markdown href relative to a workspace file path.
 * Returns a workspace-relative path, or null for external/anchor links.
 */
export function resolveWorkspaceLink(href: string, currentFilePath: string): string | null {
  const withoutFragment = href.trim().split('#')[0]?.split('?')[0]?.trim() ?? '';
  if (!withoutFragment || withoutFragment.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(withoutFragment)) return null;

  const normalizedHref = withoutFragment.replace(/\\/g, '/');

  let combined: string;
  if (normalizedHref.startsWith('/')) {
    combined = normalizedHref.slice(1);
  } else {
    const slash = currentFilePath.lastIndexOf('/');
    const dir = slash === -1 ? '' : currentFilePath.slice(0, slash);
    combined = dir ? `${dir}/${normalizedHref}` : normalizedHref;
  }

  const segments = combined.split('/').filter(Boolean);
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (resolved.length === 0) return null;
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  return resolved.length > 0 ? resolved.join('/') : null;
}
