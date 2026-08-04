'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { WorkspaceEntryTarget } from '@/components/workspace/rename-workspace-entry-dialog';

export function DeleteWorkspaceEntryDialog({
  open,
  onOpenChange,
  entry,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: WorkspaceEntryTarget | null;
  onDeleted: (path: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleDelete() {
    if (!entry) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(entry.path)}`, {
        method: 'DELETE',
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'Failed to delete.');
        return;
      }
      onOpenChange(false);
      onDeleted(entry.path);
    } catch {
      setError('Failed to delete.');
    } finally {
      setPending(false);
    }
  }

  const kind = entry?.type === 'directory' ? 'folder' : 'file';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[90vh] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Delete {kind}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 px-6 py-4 text-sm">
          <p>
            Delete <span className="font-mono font-medium">{entry?.path}</span>?
            {entry?.type === 'directory'
              ? ' The folder must be empty.'
              : ' This cannot be undone.'}
          </p>
          {error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="border-t bg-background px-6 py-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => void handleDelete()}
          >
            {pending ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
