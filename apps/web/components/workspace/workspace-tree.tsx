'use client';

import { useCallback, useRef, useState } from 'react';
import { Tree, type NodeRendererProps } from 'react-arborist';
import {
  ChevronRight,
  File,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Search,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  type ArboristNode,
  entriesToNodes,
  fetchWorkspaceEntries,
  findNode,
  mergeChildren,
} from '@/lib/workspace-tree';
import { cn } from '@/lib/utils';

function FileTypeIcon({ name }: { name: string }) {
  const className = 'h-4 w-4 shrink-0 text-muted-foreground';
  const lower = name.toLowerCase();
  if (lower.endsWith('.md')) return <FileText className={className} />;
  if (lower.endsWith('.json')) return <FileJson className={className} />;
  if (
    lower.endsWith('.js') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.ts') ||
    lower.endsWith('.tsx') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml') ||
    lower.endsWith('.css') ||
    lower.endsWith('.html') ||
    lower.endsWith('.py') ||
    lower.endsWith('.go') ||
    lower.endsWith('.rs')
  ) {
    return <FileCode className={className} />;
  }
  return <File className={className} />;
}

function WorkspaceNode({
  node,
  style,
  dragHandle,
}: NodeRendererProps<ArboristNode>) {
  const data = node.data;
  const isDir = data.type === 'directory';

  return (
    <div
      ref={dragHandle}
      style={style}
      className={cn(
        'flex items-center gap-1 rounded px-1 py-0.5 text-sm hover:bg-muted',
        node.isSelected && 'bg-muted font-medium'
      )}
    >
      {isDir ? (
        <button
          type="button"
          className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground"
          onClick={(e) => {
            e.stopPropagation();
            node.toggle();
          }}
          aria-label={node.isOpen ? 'Collapse folder' : 'Expand folder'}
        >
          <ChevronRight
            className={cn('h-3.5 w-3.5 transition-transform', node.isOpen && 'rotate-90')}
          />
        </button>
      ) : (
        <span className="h-5 w-5 shrink-0" />
      )}
      {isDir ? (
        node.isOpen ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        )
      ) : (
        <FileTypeIcon name={data.name} />
      )}
      <span className="truncate">{data.name}</span>
    </div>
  );
}

export function WorkspaceTree({
  initialNodes,
  selectedPath,
  onSelectFile,
  onSelectFolder,
}: {
  initialNodes: ArboristNode[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onSelectFolder: (path: string) => void;
}) {
  const [treeData, setTreeData] = useState<ArboristNode[]>(initialNodes);
  const [searchTerm, setSearchTerm] = useState('');
  const loadingRef = useRef<Set<string>>(new Set());

  const loadChildren = useCallback(
    async (dirPath: string) => {
      if (loadingRef.current.has(dirPath)) return;
      const existing = findNode(treeData, dirPath);
      if (existing?.isLoaded) return;

      loadingRef.current.add(dirPath);
      try {
        const entries = await fetchWorkspaceEntries(dirPath);
        const children = entriesToNodes(entries);
        setTreeData((prev) => mergeChildren(prev, dirPath, children));
      } finally {
        loadingRef.current.delete(dirPath);
      }
    },
    [treeData]
  );

  const handleToggle = useCallback(
    (id: string) => {
      const node = findNode(treeData, id);
      if (node?.type === 'directory' && !node.isLoaded) {
        void loadChildren(id);
      }
    },
    [treeData, loadChildren]
  );

  const handleActivate = useCallback(
    (node: { data: ArboristNode }) => {
      if (node.data.type === 'file') {
        onSelectFile(node.data.id);
      } else {
        onSelectFolder(node.data.id);
      }
    },
    [onSelectFile, onSelectFolder]
  );

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="relative px-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search files…"
          className="h-8 pl-8 text-sm"
        />
      </div>
      <div className="min-h-0 flex-1">
        <Tree
          data={treeData}
          width="100%"
          height={520}
          indent={16}
          rowHeight={28}
          openByDefault={false}
          selection={selectedPath ?? undefined}
          searchTerm={searchTerm}
          searchMatch={(node, term) =>
            node.data.name.toLowerCase().includes(term.toLowerCase())
          }
          disableDrag
          disableDrop
          disableEdit
          disableMultiSelection
          onToggle={handleToggle}
          onActivate={handleActivate}
        >
          {WorkspaceNode}
        </Tree>
      </div>
    </div>
  );
}
