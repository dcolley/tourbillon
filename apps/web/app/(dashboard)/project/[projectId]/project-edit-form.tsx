'use client';

import { useEffect, useActionState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormStatus } from 'react-dom';
import type { Project } from '@tourbillon/db';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { nativeSelectClassName } from '@/lib/native-select';
import type { UpdateProjectState } from '../actions';

export interface ProjectGoalOption {
  id: string;
  title: string;
}

export interface ProjectAgentOption {
  id: string;
  name: string;
  urlKey: string;
  role: string;
  title: string;
}

const initialState: UpdateProjectState = { error: null };

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : 'Save changes'}
    </Button>
  );
}

export function ProjectEditForm({
  project,
  goals,
  agents,
  action,
}: {
  project: Project;
  goals: ProjectGoalOption[];
  agents: ProjectAgentOption[];
  action: (_prev: UpdateProjectState, formData: FormData) => Promise<UpdateProjectState>;
}) {
  const router = useRouter();
  const [state, formAction] = useActionState(action, initialState);

  useEffect(() => {
    if (state?.success) {
      router.replace(`/project/${project.id}?saved=1`);
      router.refresh();
    }
  }, [state?.success, project.id, router]);

  return (
    <section className="rounded-lg border">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Edit project</h2>
      </div>
      <div className="p-4 space-y-4">
        {state?.error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {state.error}
          </div>
        )}

        <form action={formAction} className="space-y-4">
          <input type="hidden" name="projectId" value={project.id} />

          <div className="space-y-2">
            <Label htmlFor="project-edit-title">Title</Label>
            <Input
              id="project-edit-title"
              name="title"
              type="text"
              required
              defaultValue={project.title}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="project-edit-description">Description</Label>
            <Textarea
              id="project-edit-description"
              name="description"
              rows={4}
              defaultValue={project.description ?? ''}
              placeholder="Scope, milestones, constraints…"
              className="resize-y"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="project-edit-goal">Goal</Label>
              <select
                id="project-edit-goal"
                name="goalId"
                required
                defaultValue={project.goalId ?? ''}
                className={nativeSelectClassName}
              >
                <option value="" disabled>
                  Select goal…
                </option>
                {goals.map((goal) => (
                  <option key={goal.id} value={goal.id}>
                    {goal.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="project-edit-status">Status</Label>
              <select
                id="project-edit-status"
                name="status"
                defaultValue={project.status}
                className={nativeSelectClassName}
              >
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="completed">Completed</option>
                <option value="archived">Archived</option>
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="project-edit-owner">Owner agent</Label>
            <select
              id="project-edit-owner"
              name="ownerAgentId"
              defaultValue={project.ownerAgentId ?? ''}
              className={nativeSelectClassName}
            >
              <option value="">Unassigned</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} — {agent.title} ({agent.role})
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end">
            <SaveButton />
          </div>
        </form>
      </div>
    </section>
  );
}
