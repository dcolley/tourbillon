import { MarkdownContent } from '@/components/markdown-content';
import type { Issue } from '@tourbillon/db';
import type { IssueComment } from '@/lib/issue-comments';
import type { IssueAgentOption } from '@/lib/issues';
import type { CommentOnIssueState } from '../actions';
import { IssueCommentForm } from './issue-comment-form';

interface IssueCommentsSectionProps {
  issue: Issue;
  agents: IssueAgentOption[];
  comments: IssueComment[];
  commentAction: (
    _prev: CommentOnIssueState,
    formData: FormData
  ) => Promise<CommentOnIssueState>;
}

function formatAction(action: string): string {
  const labels: Record<string, string> = {
    'issue.commented': 'Comment',
    'issue.checked_out': 'Checked out',
    'issue.updated': 'Updated',
    'issue.created': 'Created',
  };
  return labels[action] ?? action.replace(/\./g, ' · ').replace(/_/g, ' ');
}

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function IssueCommentsSection({
  issue,
  agents,
  comments,
  commentAction,
}: IssueCommentsSectionProps) {
  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold">Comments</h2>
      <div className="space-y-3">
        <IssueCommentForm issue={issue} agents={agents} action={commentAction} />
        {comments.length === 0 ? (
          <p className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
            No comments yet.
          </p>
        ) : (
          <div className="rounded-lg border divide-y">
            {comments.map((comment) => (
              <div key={comment.id} className="p-4">
                <div className="mb-2 flex items-start justify-between gap-4">
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium">{comment.authorName}</p>
                    <p className="text-xs capitalize text-muted-foreground">
                      {comment.authorType} · {formatAction(comment.action)}
                    </p>
                  </div>
                  <time
                    dateTime={comment.createdAt}
                    title={new Date(comment.createdAt).toLocaleString()}
                    className="shrink-0 text-xs text-muted-foreground"
                  >
                    {formatRelativeTime(comment.createdAt)}
                  </time>
                </div>
                <MarkdownContent content={comment.body} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
