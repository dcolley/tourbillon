'use client';

import { startTransition, useState, useTransition, type FormEvent, useId } from 'react';
import { createCompanyAction } from '@/app/(dashboard)/company/actions';
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

export function CreateCompanyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (companyId: string) => void;
}) {
  const idPrefix = useId();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);

    startTransition(() => {
      void createCompanyAction(formData).then((result) => {
        if (result.ok) {
          onOpenChange(false);
          onCreated(result.id);
          return;
        }
        setError(result.error || 'Failed to create company.');
      });
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New company</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error ? (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-name`}>Company name</Label>
              <Input
                id={`${idPrefix}-name`}
                name="name"
                required
                autoFocus
                placeholder="Acme Corp"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-slug`}>Slug</Label>
              <Input id={`${idPrefix}-slug`} name="slug" placeholder="acme-corp" />
              <p className="text-xs text-muted-foreground">Leave blank to auto-generate from name.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-prefix`}>Issue prefix</Label>
              <Input
                id={`${idPrefix}-prefix`}
                name="issuePrefix"
                className="font-mono uppercase"
                placeholder="ACME"
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Creating…' : 'Create company'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
