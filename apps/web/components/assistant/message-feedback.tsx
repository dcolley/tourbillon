'use client';

/**
 * OBS-2: thumbs up / down under an assistant message. A thumbs down is saved at once and opens a
 * short, optional reason (preset tags and a note). The viewer's saved reactions for the thread are
 * loaded once (`useThreadFeedback`), so a reaction shows again whenever the message is shown.
 */
import * as React from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  FEEDBACK_REASON_MAX,
  FEEDBACK_TAG_LABEL,
  FEEDBACK_TAGS,
  type FeedbackInput,
  type FeedbackRating,
  type FeedbackTag,
  type MessageFeedback as SavedFeedback,
  type ThreadFeedback,
} from '@/lib/assistant/feedback';

export type SaveFeedback = (input: FeedbackInput) => Promise<{ ok: boolean }>;

export interface MessageFeedbackViewProps {
  saved: SavedFeedback | null;
  /** Reason panel (after a thumbs down). */
  reasonOpen: boolean;
  reason: string;
  tags: FeedbackTag[];
  saving: boolean;
  error: string | null;
  onRate: (rating: FeedbackRating) => void;
  onToggleTag: (tag: FeedbackTag) => void;
  onReasonChange: (value: string) => void;
  onSubmitReason: () => void;
  onCloseReason: () => void;
}

/** Stateless view (tested with react-dom/server). */
export function MessageFeedbackView(props: MessageFeedbackViewProps) {
  const { saved, reasonOpen } = props;
  const rating = saved?.rating ?? null;
  return (
    <div className="flex flex-col gap-1" data-message-feedback={rating ?? ''}>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="icon-xs"
          variant={rating === 'up' ? 'secondary' : 'ghost'}
          aria-label="Good response"
          aria-pressed={rating === 'up'}
          disabled={props.saving}
          onClick={() => props.onRate('up')}
        >
          <ThumbsUp />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant={rating === 'down' ? 'secondary' : 'ghost'}
          aria-label="Bad response"
          aria-pressed={rating === 'down'}
          disabled={props.saving}
          onClick={() => props.onRate('down')}
        >
          <ThumbsDown />
        </Button>
        {props.error && (
          <span role="alert" className="text-xs text-destructive">
            {props.error}
          </span>
        )}
      </div>
      {reasonOpen && (
        <form
          className="flex max-w-md flex-col gap-2 rounded-md border p-2"
          data-feedback-reason=""
          onSubmit={(e) => {
            e.preventDefault();
            props.onSubmitReason();
          }}
        >
          <span className="text-xs text-muted-foreground">What went wrong? (optional)</span>
          <div className="flex flex-wrap gap-1">
            {FEEDBACK_TAGS.map((tag) => (
              <Button
                key={tag}
                type="button"
                size="xs"
                variant={props.tags.includes(tag) ? 'secondary' : 'outline'}
                aria-pressed={props.tags.includes(tag)}
                data-feedback-tag={tag}
                onClick={() => props.onToggleTag(tag)}
              >
                {FEEDBACK_TAG_LABEL[tag]}
              </Button>
            ))}
          </div>
          <textarea
            aria-label="Reason"
            className="min-h-12 w-full resize-none rounded-md border bg-transparent p-2 text-xs"
            maxLength={FEEDBACK_REASON_MAX}
            value={props.reason}
            onChange={(e) => props.onReasonChange(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" size="xs" variant="ghost" onClick={props.onCloseReason}>
              Skip
            </Button>
            <Button type="submit" size="xs" disabled={props.saving}>
              Send
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

export interface MessageFeedbackProps {
  messageId: string;
  saved: SavedFeedback | null;
  onSave: SaveFeedback;
}

export function MessageFeedback({ messageId, saved, onSave }: MessageFeedbackProps) {
  const [reasonOpen, setReasonOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [tags, setTags] = React.useState<FeedbackTag[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const save = async (input: Omit<FeedbackInput, 'messageId'>) => {
    setSaving(true);
    setError(null);
    const r = await onSave({ messageId, ...input });
    setSaving(false);
    if (!r.ok) setError('Could not save');
    return r.ok;
  };

  return (
    <MessageFeedbackView
      saved={saved}
      reasonOpen={reasonOpen}
      reason={reason}
      tags={tags}
      saving={saving}
      error={error}
      onRate={(rating) => {
        if (rating === 'up') {
          setReasonOpen(false);
          void save({ rating: 'up' });
          return;
        }
        // Thumbs down is recorded at once (keeping an earlier reason); adding a reason is optional.
        const prior = saved?.rating === 'down' ? saved : null;
        setReason(prior?.reason ?? '');
        setTags(prior?.tags ?? []);
        setReasonOpen(true);
        void save({ rating: 'down', reason: prior?.reason ?? null, tags: prior?.tags ?? [] });
      }}
      onToggleTag={(tag) => setTags((current) => (current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag]))}
      onReasonChange={setReason}
      onSubmitReason={() => {
        void save({ rating: 'down', reason, tags }).then((ok) => {
          if (ok) setReasonOpen(false);
        });
      }}
      onCloseReason={() => setReasonOpen(false)}
    />
  );
}

export function threadFeedbackUrl(agentId: string, threadId: string): string {
  return `/api/assistant/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}/feedback`;
}

/**
 * The viewer's saved reactions for a thread (loaded once per thread) and a save function that
 * stores a reaction and updates the map. `threadId` null (thread not open yet) loads nothing.
 */
export function useThreadFeedback(agentId: string, threadId: string | null, fetchImpl?: typeof fetch) {
  const [state, setState] = React.useState<{ threadId: string | null; feedback: ThreadFeedback }>({ threadId: null, feedback: {} });
  const f = React.useMemo(() => fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args)), [fetchImpl]);

  React.useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    f(threadFeedbackUrl(agentId, threadId), { method: 'GET' })
      .then(async (res) => (res.ok ? ((await res.json()) as { feedback?: ThreadFeedback }) : null))
      .then(
        (body) => {
          if (cancelled || !body?.feedback) return;
          setState((s) => ({ threadId, feedback: { ...(s.threadId === threadId ? s.feedback : {}), ...body.feedback } }));
        },
        () => {},
      );
    return () => {
      cancelled = true;
    };
  }, [agentId, threadId, f]);

  const save = React.useCallback<SaveFeedback>(
    async (input) => {
      if (!threadId) return { ok: false };
      try {
        const res = await f(threadFeedbackUrl(agentId, threadId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!res.ok) return { ok: false };
        const body = (await res.json()) as { messageId?: string; feedback?: SavedFeedback };
        if (body.feedback && body.messageId) {
          const { messageId, feedback } = body as { messageId: string; feedback: SavedFeedback };
          setState((s) => ({
            threadId,
            feedback: { ...(s.threadId === threadId ? s.feedback : {}), [messageId]: feedback },
          }));
        }
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    [agentId, threadId, f],
  );

  const feedback = state.threadId === threadId ? state.feedback : {};
  return { feedback, save };
}
