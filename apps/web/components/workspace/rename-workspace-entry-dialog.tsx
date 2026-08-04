'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
const SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export type WorkspaceEntryTarget = {
  path: string;
  name: string;
  type: 'file' | 'directory';
};

function parentDir(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? '' : filePath.slice(0, slash);
}

function joinWorkspacePath(dir: string, name: string): string {
  const base = name.trim().replace(/^\/+/, '');
  return dir ? `${dir}/${base}` : base;
}

export function RenameWorkspaceEntryDialog({
  open,
  onOpenChange,
  entry,
  onRenamed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: WorkspaceEntryTarget | null;
  onRenamed: (from: string, to: string) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open && entry) {
      setName(entry.name);
      setError(null);
      setPending(false);
    }
  }, [open, entry]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!entry) return;

    const nextName = name.trim();
    if (!nextName) {
      setError('Name is required.');
      return;
    }
    if (!SEGMENT_RE.test(nextName)) {
      setError('Name may only contain letters, numbers, dots, underscores, and hyphens.');
      return;
    }

    const to = joinWorkspacePath(parentDir(entry.path), nextName);
    if (to === entry.path) {
      onOpenChange(false);
      return;
    }

    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/workspace/file', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: entry.path, to }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; path?: string };
      if (!res.ok) {
        setError(data.error ?? 'Failed to rename.');
        return;
      }
      onOpenChange(false);
      onRenamed(entry.path, data.path ?? to);
    } catch {
      setError('Failed to rename.');
    } finally {
      setPending(false);
    }
  }

  const kind = entry?.type === 'directory' ? 'folder' : 'file';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="border-b px-6 py-4">
            <DialogTitle>Rename {kind}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 overflow-y-auto px-6 py-4">
            {error && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="rename-entry-name">Name</Label>
              <Input
                id="rename-entry-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                required
              />
            </div>
          </div>

          <DialogFooter className="border-t bg-background px-6 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Renaming…' : 'Rename'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
