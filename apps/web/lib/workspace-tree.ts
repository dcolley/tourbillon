import type { WorkspaceEntry } from '@tourbillon/shared/company-workspace-types';

export type ArboristNode = {
  id: string;
  name: string;
  type: 'file' | 'directory';
  children?: ArboristNode[];
  isLoaded?: boolean;
};

export function entryToNode(entry: WorkspaceEntry): ArboristNode {
  if (entry.type === 'directory') {
    return {
      id: entry.path,
      name: entry.name,
      type: 'directory',
      children: [],
      isLoaded: false,
    };
  }
  return {
    id: entry.path,
    name: entry.name,
    type: 'file',
  };
}

export function entriesToNodes(entries: WorkspaceEntry[]): ArboristNode[] {
  return entries.map(entryToNode);
}

export function mergeChildren(
  tree: ArboristNode[],
  parentPath: string,
  children: ArboristNode[]
): ArboristNode[] {
  if (!parentPath) {
    const byId = new Map(children.map((n) => [n.id, n]));
    return tree.map((node) => byId.get(node.id) ?? node);
  }

  return tree.map((node) => {
    if (node.id === parentPath && node.type === 'directory') {
      return { ...node, children, isLoaded: true };
    }
    if (node.children?.length) {
      return { ...node, children: mergeChildren(node.children, parentPath, children) };
    }
    return node;
  });
}

export function findNode(tree: ArboristNode[], id: string): ArboristNode | null {
  for (const node of tree) {
    if (node.id === id) return node;
    if (node.children?.length) {
      const found = findNode(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

export async function fetchWorkspaceEntries(
  relativeDir: string
): Promise<WorkspaceEntry[]> {
  const params = new URLSearchParams();
  if (relativeDir) params.set('path', relativeDir);
  const res = await fetch(`/api/workspace?${params.toString()}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to list workspace (${res.status})`);
  }
  const data = (await res.json()) as { entries: WorkspaceEntry[] };
  return data.entries;
}
