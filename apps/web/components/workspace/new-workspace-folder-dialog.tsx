'use client';

import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useFormStatus } from 'react-dom';
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
import {
  createWorkspaceDirectoryAction,
  type WorkspaceActionState,
} from '@/app/(dashboard)/workspace/actions';

const SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const initialState: WorkspaceActionState & { path?: string } = { error: null };

function joinWorkspacePath(folder: string, name: string): string {
  const dir = folder.trim().replace(/^\/+|\/+$/g, '');
  const base = name.trim().replace(/^\/+/, '');
  return dir ? `${dir}/${base}` : base;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Creating…' : 'Create folder'}
    </Button>
  );
}

export function NewWorkspaceFolderDialog({
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
  const [parentFolder, setParentFolder] = useState(defaultFolder);
  const [folderName, setFolderName] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);
  const [state, formAction] = useActionState(createWorkspaceDirectoryAction, initialState);
  const handledPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (open) {
      setParentFolder(defaultFolder);
      setFolderName('');
      setClientError(null);
    }
  }, [open, defaultFolder]);

  useEffect(() => {
    if (state?.success && state.path && state.path !== handledPathRef.current) {
      handledPathRef.current = state.path;
      startTransition(() => {
        onOpenChange(false);
        onCreated(state.path!);
      });
    }
  }, [state?.success, state?.path, onOpenChange, onCreated]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    const name = folderName.trim();
    if (!name) {
      e.preventDefault();
      setClientError('Folder name is required.');
      return;
    }
    if (!SEGMENT_RE.test(name)) {
      e.preventDefault();
      setClientError(
        'Folder name may only contain letters, numbers, dots, underscores, and hyphens.'
      );
      return;
    }
    setClientError(null);
  }

  const path = joinWorkspacePath(parentFolder, folderName);
  const error = clientError ?? state?.error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <form action={formAction} onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <input type="hidden" name="path" value={path} />
          <DialogHeader className="border-b px-6 py-4">
            <DialogTitle>New folder</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 overflow-y-auto px-6 py-4">
            {error && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="new-folder-name">Folder name</Label>
              <Input
                id="new-folder-name"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                placeholder="notes"
                autoFocus
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-folder-parent">Parent folder (optional)</Label>
              <Input
                id="new-folder-parent"
                value={parentFolder}
                onChange={(e) => setParentFolder(e.target.value)}
                placeholder="resources"
              />
            </div>
          </div>

          <DialogFooter className="border-t bg-background px-6 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <SubmitButton />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
