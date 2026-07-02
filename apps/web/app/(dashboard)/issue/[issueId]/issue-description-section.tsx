'use client';

import { startTransition, useEffect, useState, useActionState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormStatus } from 'react-dom';
import { MarkdownContent } from '@/components/markdown-content';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { UpdateIssueDescriptionState } from '../actions';

const initialState: UpdateIssueDescriptionState = { error: null };

const textareaClassName =
  'w-full min-h-[12rem] resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm';

function SaveDescriptionButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? 'Saving…' : 'Save'}
    </Button>
  );
}

export function IssueDescriptionSection({
  issueId,
  description,
  action,
}: {
  issueId: string;
  description: string | null;
  action: (
    _prev: UpdateIssueDescriptionState,
    formData: FormData
  ) => Promise<UpdateIssueDescriptionState>;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [draft, setDraft] = useState(description ?? '');
  const [state, formAction] = useActionState(action, initialState);

  useEffect(() => {
    setDraft(description ?? '');
  }, [description]);

  useEffect(() => {
    if (state?.success) {
      startTransition(() => {
        setMode('view');
        router.replace(`/issue/${issueId}?saved=1`);
        router.refresh();
      });
    }
  }, [state?.success, issueId, router]);

  function cancelEdit() {
    setDraft(description ?? '');
    setMode('view');
  }

  const hasDescription = Boolean(description?.trim());

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-3">
        <CardTitle className="text-base">Description</CardTitle>
        <div className="inline-flex rounded-md border text-xs overflow-hidden shrink-0">
          <button
            type="button"
            onClick={() => setMode('view')}
            className={`px-2.5 py-1 transition-colors ${
              mode === 'view'
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            View
          </button>
          <button
            type="button"
            onClick={() => setMode('edit')}
            className={`px-2.5 py-1 border-l transition-colors ${
              mode === 'edit'
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Edit
          </button>
        </div>
      </CardHeader>

      <CardContent>
        {mode === 'view' ? (
          hasDescription ? (
            <MarkdownContent content={description!} showModeToggle={false} />
          ) : (
            <p className="text-sm text-muted-foreground">No description yet.</p>
          )
        ) : (
          <form action={formAction} className="space-y-3">
            {state?.error && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {state.error}
              </div>
            )}
            <input type="hidden" name="issueId" value={issueId} />
            <textarea
              id="issue-description-edit"
              name="description"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Write a description in Markdown…"
              className={textareaClassName}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={cancelEdit}>
                Cancel
              </Button>
              <SaveDescriptionButton />
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
