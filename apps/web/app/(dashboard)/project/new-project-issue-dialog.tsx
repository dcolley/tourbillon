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
import { createProjectIssueAction, type CreateProjectIssueState } from './actions';

interface AgentOption {
  id: string;
  name: string;
  urlKey: string;
}

const initialState: CreateProjectIssueState = { error: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Creating…' : 'Create issue'}
    </Button>
  );
}

export function NewProjectIssueDialog({
  projectId,
  agents,
}: {
  projectId: string;
  agents: AgentOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(createProjectIssueAction, initialState);

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
        Add issue
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[90vh] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
          <form action={formAction} className="flex min-h-0 flex-1 flex-col">
            <input type="hidden" name="projectId" value={projectId} />

            <DialogHeader className="border-b px-6 py-4">
              <DialogTitle>New issue for project</DialogTitle>
            </DialogHeader>

            <div className="space-y-4 overflow-y-auto px-6 py-4">
              {state?.error && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {state.error}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="project-issue-title">Title</Label>
                <Input
                  id="project-issue-title"
                  name="title"
                  type="text"
                  required
                  autoFocus
                  placeholder="What should be done?"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="project-issue-description">Description</Label>
                <Textarea
                  id="project-issue-description"
                  name="description"
                  rows={3}
                  placeholder="Optional details…"
                  className="resize-y"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="project-issue-priority">Priority</Label>
                  <select
                    id="project-issue-priority"
                    name="priority"
                    defaultValue="medium"
                    className={nativeSelectClassName}
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="project-issue-status">Status</Label>
                  <select
                    id="project-issue-status"
                    name="status"
                    defaultValue="todo"
                    className={nativeSelectClassName}
                  >
                    <option value="backlog">Backlog</option>
                    <option value="todo">Todo</option>
                    <option value="in_progress">In progress</option>
                  </select>
                </div>
              </div>

              {agents.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="project-issue-assignee">Assign to agent</Label>
                  <select
                    id="project-issue-assignee"
                    name="assigneeAgentId"
                    defaultValue=""
                    className={nativeSelectClassName}
                  >
                    <option value="">Unassigned</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name} ({agent.urlKey})
                      </option>
                    ))}
                  </select>
                </div>
              )}
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
