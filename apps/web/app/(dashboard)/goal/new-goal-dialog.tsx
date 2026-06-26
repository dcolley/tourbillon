'use client';

import { startTransition, useEffect, useState, useActionState } from 'react';
import { useRouter } from 'next/navigation';
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
import { Textarea } from '@/components/ui/textarea';
import { nativeSelectClassName } from '@/lib/native-select';
import { createGoalAction, type CreateGoalState } from './actions';

const initialState: CreateGoalState = { error: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Creating…' : 'Create goal'}
    </Button>
  );
}

export function NewGoalDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(createGoalAction, initialState);

  useEffect(() => {
    if (state?.success) {
      startTransition(() => {
        setOpen(false);
        router.refresh();
      });
    }
  }, [state?.success, router]);

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        + New goal
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[90vh] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
          <form action={formAction} className="flex min-h-0 flex-1 flex-col">
            <DialogHeader className="border-b px-6 py-4">
              <DialogTitle>New goal</DialogTitle>
            </DialogHeader>

            <div className="space-y-4 overflow-y-auto px-6 py-4">
              {state?.error && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {state.error}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="goal-title">Title</Label>
                <Input
                  id="goal-title"
                  name="title"
                  type="text"
                  required
                  autoFocus
                  placeholder="What are we trying to achieve?"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="goal-description">Description</Label>
                <Textarea
                  id="goal-description"
                  name="description"
                  rows={4}
                  placeholder="Context, success criteria, constraints…"
                  className="resize-y"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="goal-status">Status</Label>
                <select
                  id="goal-status"
                  name="status"
                  defaultValue="active"
                  className={nativeSelectClassName}
                >
                  <option value="active">Active</option>
                  <option value="completed">Completed</option>
                  <option value="archived">Archived</option>
                </select>
              </div>
            </div>

            <DialogFooter className="border-t bg-background">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
