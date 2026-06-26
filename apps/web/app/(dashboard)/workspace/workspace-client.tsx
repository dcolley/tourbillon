'use client';

import { useCallback, useState, useActionState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormStatus } from 'react-dom';
import type { ArboristNode } from '@/lib/workspace-tree';
import { entriesToNodes } from '@/lib/workspace-tree';
import type { WorkspaceEntry } from '@tourbillon/shared/company-workspace-types';
import { WorkspaceTree } from '@/components/workspace/workspace-tree';
import { WorkspaceFilePane } from '@/components/workspace/workspace-file-pane';
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

      <form
        action={uploadAction}
        className="flex flex-wrap items-end gap-3 rounded-lg border p-4"
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
        {uploadState.error && <p className="w-full text-sm text-destructive">{uploadState.error}</p>}
        {uploadState.success && <p className="w-full text-sm text-green-700">Uploaded.</p>}
      </form>

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
          />
        </div>

        <div className="min-h-[560px] rounded-lg border p-4">
          <WorkspaceFilePane
            key={selectedPath ?? 'empty'}
            path={selectedPath}
            hydratedPath={hydratedPath}
            hydratedContent={hydratedContent}
            onSaved={handleSaved}
            onNavigate={handleSelectFile}
            deleteForm={deleteForm}
          />
        </div>
      </div>
    </div>
  );
}
