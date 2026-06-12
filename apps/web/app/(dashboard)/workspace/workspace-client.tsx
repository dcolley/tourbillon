'use client';

import { useMemo, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useFormState, useFormStatus } from 'react-dom';
import type { WorkspaceEntry } from '@tourbillon/shared/company-workspace-types';
import { isMarkdownPath, isTextEditablePath } from '@tourbillon/shared/company-workspace-types';
import { MarkdownContent } from '@/components/markdown-content';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  deleteWorkspaceFileAction,
  saveWorkspaceFileAction,
  uploadWorkspaceFileAction,
  type WorkspaceActionState,
} from './actions';

const initialState: WorkspaceActionState = { error: null };

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  );
}

type TreeNode = { entry?: WorkspaceEntry; children: Record<string, TreeNode> };

function buildTree(entries: WorkspaceEntry[]): Record<string, TreeNode> {
  const root: Record<string, TreeNode> = {};
  for (const entry of entries) {
    const parts = entry.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (!node[part]) node[part] = { children: {} };
      if (i === parts.length - 1) node[part]!.entry = entry;
      node = node[part]!.children;
    }
  }
  return root;
}

function TreeBranch({
  name,
  node,
  selectedPath,
  currentDir,
  onSelect,
  onNavigate,
  depth,
}: {
  name: string;
  node: TreeNode;
  selectedPath: string | null;
  currentDir: string;
  onSelect: (path: string) => void;
  onNavigate: (dir: string) => void;
  depth: number;
}) {
  const entry = node.entry;
  const isDir = entry?.type === 'directory';
  const path = entry?.path ?? (currentDir ? `${currentDir}/${name}` : name);
  const isSelected = selectedPath === path;

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (isDir) onNavigate(path);
          else onSelect(path);
        }}
        className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted ${
          isSelected ? 'bg-muted font-medium' : ''
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <span className="text-muted-foreground">{isDir ? '📁' : '📄'}</span>
        <span className="truncate">{name}</span>
      </button>
      {isDir &&
        Object.entries(node.children)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([childName, childNode]) => (
            <TreeBranch
              key={`${path}/${childName}`}
              name={childName}
              node={childNode}
              selectedPath={selectedPath}
              currentDir={path}
              onSelect={onSelect}
              onNavigate={onNavigate}
              depth={depth + 1}
            />
          ))}
    </div>
  );
}

export function WorkspaceClient({
  entries,
  workspaceRoot,
  companyWorkspaceDir,
  selectedPath,
  fileContent,
  fileSize,
}: {
  entries: WorkspaceEntry[];
  workspaceRoot: string;
  companyWorkspaceDir: string;
  selectedPath: string | null;
  fileContent: string | null;
  fileSize: number | null;
}) {
  const router = useRouter();
  const [activePath, setActivePath] = useState<string | null>(selectedPath);
  const [browseDir, setBrowseDir] = useState('');
  const [editing, setEditing] = useState(false);
  const [saveState, saveAction] = useFormState(saveWorkspaceFileAction, initialState);
  const [deleteState, deleteAction] = useFormState(deleteWorkspaceFileAction, initialState);
  const [uploadState, uploadAction] = useFormState(uploadWorkspaceFileAction, initialState);

  useEffect(() => {
    setActivePath(selectedPath);
    setEditing(false);
  }, [selectedPath]);

  useEffect(() => {
    if (saveState.success) setEditing(false);
  }, [saveState.success]);

  function selectFile(path: string) {
    setActivePath(path);
    setEditing(false);
    router.push(`/workspace?path=${encodeURIComponent(path)}`);
  }

  const tree = useMemo(() => buildTree(entries), [entries]);
  const editable = activePath ? isTextEditablePath(activePath) : false;
  const markdown = activePath ? isMarkdownPath(activePath) : false;
  const showPreview = editable && markdown && !editing;
  const showEditor = editable && (!markdown || editing);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">Root:</span> {workspaceRoot}
        </p>
        <p>
          <span className="font-medium text-foreground">Company:</span> {companyWorkspaceDir}
        </p>
      </div>

      <form action={uploadAction} className="flex flex-wrap items-end gap-3 rounded-lg border p-4">
        <div className="space-y-1">
          <Label htmlFor="targetDir">Target folder (optional)</Label>
          <Input
            id="targetDir"
            name="targetDir"
            placeholder="resources"
            defaultValue={browseDir}
            className="w-48"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="file">Upload file</Label>
          <Input id="file" name="file" type="file" required />
        </div>
        <SubmitButton label="Upload" />
        {uploadState.error && <p className="w-full text-sm text-destructive">{uploadState.error}</p>}
        {uploadState.success && <p className="w-full text-sm text-green-700">Uploaded.</p>}
      </form>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <div className="rounded-lg border p-2">
          <p className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Files
          </p>
          <button
            type="button"
            onClick={() => {
              setBrowseDir('');
              setActivePath(null);
            }}
            className="mb-1 w-full rounded px-2 py-1 text-left text-sm hover:bg-muted"
          >
            📁 /
          </button>
          {Object.entries(tree)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, node]) => (
              <TreeBranch
                key={name}
                name={name}
                node={node}
                selectedPath={activePath}
                currentDir=""
                onSelect={selectFile}
                onNavigate={setBrowseDir}
                depth={0}
              />
            ))}
        </div>

        <div className="rounded-lg border p-4">
          {!activePath && (
            <p className="text-sm text-muted-foreground">Select a file from the tree to view or edit.</p>
          )}

          {activePath && !editable && (
            <div className="space-y-3">
              <div>
                <p className="font-mono text-sm">{activePath}</p>
                {fileSize != null && (
                  <p className="text-sm text-muted-foreground">{(fileSize / 1024).toFixed(1)} KB</p>
                )}
              </div>
              <a
                href={`/api/workspace/file?path=${encodeURIComponent(activePath)}`}
                className="inline-flex text-sm text-primary underline"
              >
                Download file
              </a>
              <form action={deleteAction} className="pt-2">
                <input type="hidden" name="path" value={activePath} />
                <SubmitButton label="Delete" />
                {deleteState.error && <p className="mt-2 text-sm text-destructive">{deleteState.error}</p>}
              </form>
            </div>
          )}

          {activePath && showPreview && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-sm">{activePath}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              </div>
              <MarkdownContent content={fileContent ?? ''} />
              <form action={deleteAction} className="border-t pt-3">
                <input type="hidden" name="path" value={activePath} />
                <SubmitButton label="Delete file" />
                {deleteState.error && <p className="mt-2 text-sm text-destructive">{deleteState.error}</p>}
              </form>
            </div>
          )}

          {activePath && showEditor && (
            <form action={saveAction} className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-sm">{activePath}</p>
                <div className="flex gap-2">
                  {markdown && (
                    <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                  )}
                  <SubmitButton label="Save" />
                </div>
              </div>
              <input type="hidden" name="path" value={activePath} />
              <Textarea
                name="content"
                defaultValue={fileContent ?? ''}
                className="min-h-[420px] font-mono text-sm"
                key={`${activePath}-${editing ? 'edit' : 'view'}`}
              />
              {saveState.error && <p className="text-sm text-destructive">{saveState.error}</p>}
              {saveState.success && <p className="text-sm text-green-700">Saved.</p>}
            </form>
          )}

          {activePath && showEditor && (
            <form action={deleteAction} className="mt-3 border-t pt-3">
              <input type="hidden" name="path" value={activePath} />
              <SubmitButton label="Delete file" />
              {deleteState.error && <p className="mt-2 text-sm text-destructive">{deleteState.error}</p>}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
