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
import { isTextEditablePath } from '@tourbillon/shared/company-workspace-types';

function joinWorkspacePath(folder: string, name: string): string {
  const dir = folder.trim().replace(/^\/+|\/+$/g, '');
  const base = name.trim().replace(/^\/+/, '');
  return dir ? `${dir}/${base}` : base;
}

export function NewWorkspaceFileDialog({
  open,
  onOpenChange,
  defaultFolder,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultFolder: string;
  onCreated: (path: string) => void;
}) {
  const [folder, setFolder] = useState(defaultFolder);
  const [filename, setFilename] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setFolder(defaultFolder);
      setFilename('');
      setError(null);
      setPending(false);
    }
  }, [open, defaultFolder]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const name = filename.trim();
    if (!name) {
      setError('Filename is required.');
      return;
    }
    const path = joinWorkspacePath(folder, name);
    if (!isTextEditablePath(path)) {
      setError('Use an editable extension: .md, .txt, .json, .jsonl, .yaml, .yml, or .csv.');
      return;
    }

    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/workspace/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: '' }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; path?: string };
      if (!res.ok) {
        setError(data.error ?? 'Failed to create file.');
        return;
      }
      onOpenChange(false);
      onCreated(data.path ?? path);
    } catch {
      setError('Failed to create file.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="border-b px-6 py-4">
            <DialogTitle>New file</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 overflow-y-auto px-6 py-4">
            {error && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="new-file-name">Filename</Label>
              <Input
                id="new-file-name"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                placeholder="notes.md"
                autoFocus
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-file-folder">Folder (optional)</Label>
              <Input
                id="new-file-folder"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="resources"
              />
            </div>
          </div>

          <DialogFooter className="border-t bg-background px-6 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Creating…' : 'Create file'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
