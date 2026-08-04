'use client';

import { useCallback, useState, useActionState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormStatus } from 'react-dom';
import type { ArboristNode } from '@/lib/workspace-tree';
import { entriesToNodes } from '@/lib/workspace-tree';
import type { WorkspaceEntry } from '@tourbillon/shared/company-workspace-types';
import { WorkspaceTree } from '@/components/workspace/workspace-tree';
import { WorkspaceFilePane } from '@/components/workspace/workspace-file-pane';
import { NewWorkspaceFileDialog } from '@/components/workspace/new-workspace-file-dialog';
import { NewWorkspaceFolderDialog } from '@/components/workspace/new-workspace-folder-dialog';
import {
  RenameWorkspaceEntryDialog,
  type WorkspaceEntryTarget,
} from '@/components/workspace/rename-workspace-entry-dialog';
import { DeleteWorkspaceEntryDialog } from '@/components/workspace/delete-workspace-entry-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { uploadWorkspaceFileAction, deleteWorkspaceFileAction, type WorkspaceActionState } from './actions';

const initialState: WorkspaceActionState = { error: null };

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? 'Working…' : label}
    </Button>
  );
}

export function WorkspaceClient({
  initialEntries,
  selectedPath: initialSelectedPath,
  initialContent,
  workspaceRoot,
  companyWorkspaceDir,
}: {
  initialEntries: WorkspaceEntry[];
  selectedPath: string | null;
  initialContent: string | null;
  workspaceRoot: string;
  companyWorkspaceDir: string;
}) {
  const router = useRouter();
  const [selectedPath, setSelectedPath] = useState<string | null>(initialSelectedPath);
  const [targetDir, setTargetDir] = useState('');
  const [showPaths, setShowPaths] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [startInEdit, setStartInEdit] = useState(false);
  const [renameEntry, setRenameEntry] = useState<WorkspaceEntryTarget | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<WorkspaceEntryTarget | null>(null);
  const [hydratedPath] = useState(initialSelectedPath);
  const [hydratedContent] = useState(initialContent);

  const [deleteState, deleteAction] = useActionState(deleteWorkspaceFileAction, initialState);
  const [uploadState, uploadAction] = useActionState(uploadWorkspaceFileAction, initialState);

  const initialNodes: ArboristNode[] = entriesToNodes(initialEntries);
  const treeKey = initialEntries.map((e) => `${e.path}:${e.updatedAt ?? ''}`).join('|');

  const updateUrl = useCallback(
    (path: string | null) => {
      if (path) {
        router.replace(`/workspace?path=${encodeURIComponent(path)}`, { scroll: false });
      } else {
        router.replace('/workspace', { scroll: false });
      }
    },
    [router]
  );

  const handleSelectFile = useCallback(
    (path: string) => {
      setStartInEdit(false);
      setSelectedPath(path);
      updateUrl(path);
    },
    [updateUrl]
  );

  const handleEditFile = useCallback(
    (path: string) => {
      setStartInEdit(true);
      setSelectedPath(path);
      updateUrl(path);
    },
    [updateUrl]
  );

  const handleSelectFolder = useCallback((path: string) => {
    setTargetDir(path);
  }, []);

  const handleSaved = useCallback(() => {
    router.refresh();
  }, [router]);

  const handleFileCreated = useCallback(
    (path: string) => {
      router.refresh();
      handleSelectFile(path);
    },
    [router, handleSelectFile]
  );

  const handleFolderCreated = useCallback(
    (path: string) => {
      setTargetDir(path);
      router.refresh();
    },
    [router]
  );

  const handleRenamed = useCallback(
    (from: string, to: string) => {
      if (selectedPath === from || selectedPath?.startsWith(`${from}/`)) {
        const next =
          selectedPath === from ? to : `${to}${selectedPath.slice(from.length)}`;
        setSelectedPath(next);
        updateUrl(next);
      }
      if (targetDir === from || targetDir.startsWith(`${from}/`)) {
        const next = targetDir === from ? to : `${to}${targetDir.slice(from.length)}`;
        setTargetDir(next);
      }
      router.refresh();
    },
    [selectedPath, targetDir, updateUrl, router]
  );

  const handleDeleted = useCallback(
    (path: string) => {
      if (selectedPath === path || selectedPath?.startsWith(`${path}/`)) {
        setSelectedPath(null);
        updateUrl(null);
      }
      if (targetDir === path || targetDir.startsWith(`${path}/`)) {
        setTargetDir('');
      }
      router.refresh();
    },
    [selectedPath, targetDir, updateUrl, router]
  );

  const deleteForm = selectedPath ? (
    <form action={deleteAction}>
      <input type="hidden" name="path" value={selectedPath} />
      <SubmitButton label="Delete file" />
      {deleteState.error && <p className="mt-2 text-sm text-destructive">{deleteState.error}</p>}
    </form>
  ) : null;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">
        <button
          type="button"
          onClick={() => setShowPaths((v) => !v)}
          className="text-muted-foreground hover:text-foreground"
        >
          {showPaths ? 'Hide' : 'Show'} storage paths
        </button>
        {showPaths && (
          <div className="mt-2 space-y-1 text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Root:</span> {workspaceRoot}
            </p>
            <p>
              <span className="font-medium text-foreground">Company:</span> {companyWorkspaceDir}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border p-4">
        <form
          action={uploadAction}
          className="flex flex-wrap items-end gap-3"
          onSubmit={() => {
            queueMicrotask(() => router.refresh());
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="targetDir">Target folder (optional)</Label>
            <Input
              id="targetDir"
              name="targetDir"
              placeholder="resources"
              value={targetDir}
              onChange={(e) => setTargetDir(e.target.value)}
              className="w-48"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="file">Upload file</Label>
            <Input id="file" name="file" type="file" required />
          </div>
          <SubmitButton label="Upload" />
        </form>
        <Button type="button" size="sm" variant="outline" onClick={() => setNewFileOpen(true)}>
          New file
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setNewFolderOpen(true)}>
          New folder
        </Button>
        {uploadState.error && <p className="w-full text-sm text-destructive">{uploadState.error}</p>}
        {uploadState.success && <p className="w-full text-sm text-green-700">Uploaded.</p>}
      </div>

      <NewWorkspaceFileDialog
        open={newFileOpen}
        onOpenChange={setNewFileOpen}
        defaultFolder={targetDir}
        onCreated={handleFileCreated}
      />
      <NewWorkspaceFolderDialog
        open={newFolderOpen}
        onOpenChange={setNewFolderOpen}
        defaultFolder={targetDir}
        onCreated={handleFolderCreated}
      />
      <RenameWorkspaceEntryDialog
        open={renameEntry !== null}
        onOpenChange={(open) => {
          if (!open) setRenameEntry(null);
        }}
        entry={renameEntry}
        onRenamed={handleRenamed}
      />
      <DeleteWorkspaceEntryDialog
        open={deleteEntry !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteEntry(null);
        }}
        entry={deleteEntry}
        onDeleted={handleDeleted}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(280px,320px)_1fr]">
        <div className="flex min-h-[560px] flex-col rounded-lg border p-2">
          <p className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Files
          </p>
          <WorkspaceTree
            key={treeKey}
            initialNodes={initialNodes}
            selectedPath={selectedPath}
            onSelectFile={handleSelectFile}
            onSelectFolder={handleSelectFolder}
            onEditFile={handleEditFile}
            onRenameEntry={setRenameEntry}
            onDeleteEntry={setDeleteEntry}
          />
        </div>

        <div className="min-h-[560px] rounded-lg border p-4">
          <WorkspaceFilePane
            key={selectedPath ?? 'empty'}
            path={selectedPath}
            hydratedPath={hydratedPath}
            hydratedContent={hydratedContent}
            startInEdit={startInEdit}
            onStartInEditConsumed={() => setStartInEdit(false)}
            onSaved={handleSaved}
            onNavigate={handleSelectFile}
            deleteForm={deleteForm}
          />
        </div>
      </div>
    </div>
  );
}
