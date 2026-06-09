'use client';

import { useFormState, useFormStatus } from 'react-dom';
import type { Issue } from '@tourbillon/db';
import type { IssueAgentOption } from '@/lib/issues';
import type { CommentOnIssueState } from '../actions';

const initialState: CommentOnIssueState = { error: null };

const inputClassName =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
const selectClassName = inputClassName;

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
    >
      {pending ? 'Posting…' : 'Post comment'}
    </button>
  );
}

export function IssueCommentForm({
  issue,
  agents,
  action,
}: {
  issue: Issue;
  agents: IssueAgentOption[];
  action: (_prev: CommentOnIssueState, formData: FormData) => Promise<CommentOnIssueState>;
}) {
  const [state, formAction] = useFormState(action, initialState);

  return (
    <div className="rounded-lg border bg-muted/30">
      <form action={formAction} className="space-y-4 p-4">
        {state?.error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {state.error}
          </div>
        )}

        <input type="hidden" name="issueId" value={issue.id} />

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="issue-comment" className="text-sm font-medium">
              Comment
            </label>
            <textarea
              id="issue-comment"
              name="comment"
              rows={4}
              required
              placeholder="Add a comment…"
              className={`${inputClassName} resize-y`}
            />
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="comment-status" className="text-sm font-medium">
                Status
              </label>
              <select
                id="comment-status"
                name="status"
                defaultValue={issue.status}
                className={selectClassName}
              >
                <option value="backlog">Backlog</option>
                <option value="todo">Todo</option>
                <option value="in_progress">In progress</option>
                <option value="in_review">In review</option>
                <option value="done">Done</option>
                <option value="blocked">Blocked</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="comment-priority" className="text-sm font-medium">
                Priority
              </label>
              <select
                id="comment-priority"
                name="priority"
                defaultValue={issue.priority}
                className={selectClassName}
              >
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="comment-assignee" className="text-sm font-medium">
                Assigned
              </label>
              <select
                id="comment-assignee"
                name="assigneeAgentId"
                defaultValue={issue.assigneeAgentId ?? ''}
                className={selectClassName}
              >
                <option value="">Unassigned</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <SubmitButton />
        </div>
      </form>
    </div>
  );
}
