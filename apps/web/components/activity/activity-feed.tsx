/**
 * ACT-1: shared activity list for the Control Pane Activity page and the per-issue feed.
 * Server component (no client state): rows expand with <details>, ids show on hover (title) and
 * in Raw details, where they can be selected and copied.
 */
import Link from 'next/link';
import {
  absoluteTimestamp,
  formatRelativeTime,
  groupActivityViews,
  shortId,
  type ActivityChangeValue,
  type ActivityLink,
  type ActivityView,
} from '@/lib/activity-view';

export function ActivityItemLink({ link, className }: { link: ActivityLink; className?: string }) {
  const title = `${link.kind} id: ${link.id}`;
  if (!link.href) {
    return (
      <span className={className ?? 'text-muted-foreground'} title={title} data-activity-id={link.id}>
        {link.label}
      </span>
    );
  }
  return (
    <Link
      href={link.href}
      className={className ?? 'font-medium underline-offset-4 hover:underline'}
      title={title}
      data-activity-id={link.id}
    >
      {link.label}
    </Link>
  );
}

function ChangeValue({ value }: { value: ActivityChangeValue }) {
  if ('link' in value) return <ActivityItemLink link={value.link} />;
  return <span className="font-medium">{value.text}</span>;
}

function ActorLine({ view }: { view: ActivityView }) {
  const { actor } = view;
  const label = actor.href ? (
    <Link href={actor.href} className="underline-offset-4 hover:underline" title={`agent id: ${actor.id}`}>
      {actor.label}
    </Link>
  ) : (
    <span title={`${actor.type} id: ${actor.id}`}>{actor.label}</span>
  );
  return (
    <p className="text-muted-foreground" data-testid="activity-actor">
      {label}
      {actor.viaApproval ? (
        <>
          {', via approval '}
          <ActivityItemLink link={actor.viaApproval} />
          {actor.viaOutcome ? ` ${actor.viaOutcome}` : ''}
          {actor.viaDecider ? ` by ${actor.viaDecider}` : ''}
        </>
      ) : null}
      {actor.run ? (
        <>
          {', '}
          <ActivityItemLink link={actor.run} />
        </>
      ) : null}
    </p>
  );
}

export function ActivityRow({ view, showItem = true }: { view: ActivityView; showItem?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 p-4 text-sm" data-activity-row={view.id}>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">
          {view.actionLabel}
          {showItem && view.item ? (
            <>
              {' · '}
              <ActivityItemLink link={view.item} />
            </>
          ) : null}
          {showItem && !view.item ? (
            <span className="font-normal text-muted-foreground" title={`${view.entityType} id: ${view.entityId}`}>
              {' · '}
              {view.entityType.replace(/_/g, ' ')}
            </span>
          ) : null}
        </p>
        <ActorLine view={view} />

        {view.changes.length > 0 ? (
          <ul className="space-y-0.5 text-xs">
            {view.changes.map((change) => (
              <li key={change.field}>
                <span className="text-muted-foreground">{change.label}</span>{' '}
                {change.from ? (
                  <>
                    <ChangeValue value={change.from} />
                    {' → '}
                  </>
                ) : (
                  '→ '
                )}
                <ChangeValue value={change.to} />
              </li>
            ))}
          </ul>
        ) : null}

        {view.decision ? (
          <p className="text-xs">
            <span className="text-muted-foreground">Decision</span>{' '}
            <span className="font-medium capitalize">{view.decision.outcome}</span>
            {view.decision.answer ? <> · answer {view.decision.answer}</> : null}
            {view.decision.reason ? (
              <>
                {' · '}
                <span className="text-muted-foreground">reason</span> {view.decision.reason}
              </>
            ) : null}
          </p>
        ) : null}

        {view.comment ? (
          view.comment.truncated ? (
            <details className="text-xs">
              <summary className="cursor-pointer whitespace-pre-wrap break-words">{view.comment.excerpt}</summary>
              <p className="mt-1 whitespace-pre-wrap break-words">{view.comment.full}</p>
            </details>
          ) : (
            <p className="whitespace-pre-wrap break-words text-xs">{view.comment.excerpt}</p>
          )
        ) : null}

        {view.related.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {'Related: '}
            {view.related.map((link, i) => (
              <span key={`${link.kind}:${link.id}`}>
                {i > 0 ? ', ' : ''}
                <ActivityItemLink link={link} />
              </span>
            ))}
          </p>
        ) : null}

        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Raw details</summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-[11px] select-all">
            {JSON.stringify(
              {
                id: view.id,
                action: view.action,
                entityType: view.entityType,
                entityId: view.entityId,
                actorType: view.actor.type,
                actorId: view.actor.id,
                correlationId: view.correlationId,
                createdAt: view.createdAt.toISOString(),
                details: view.details,
              },
              null,
              2,
            )}
          </pre>
        </details>
      </div>
      <time
        className="shrink-0 text-xs text-muted-foreground"
        dateTime={view.createdAt.toISOString()}
        title={absoluteTimestamp(view.createdAt)}
      >
        {formatRelativeTime(view.createdAt)}
      </time>
    </div>
  );
}

/** Rows grouped by correlation id; a group of one renders as a plain row. */
export function ActivityFeed({
  views,
  showItem = true,
  correlationHref,
}: {
  views: ActivityView[];
  showItem?: boolean;
  /** Link to every row of one action (e.g. the Activity page filtered on the correlation id). */
  correlationHref?: (correlationId: string) => string;
}) {
  const groups = groupActivityViews(views);
  return (
    <div className="divide-y">
      {groups.map((group) =>
        group.correlationId && group.rows.length > 1 ? (
          <div key={`g:${group.correlationId}`} className="bg-muted/20" data-activity-group={group.correlationId}>
            <p className="px-4 pt-3 text-xs text-muted-foreground" title={`correlation id: ${group.correlationId}`}>
              {group.rows.length} rows from one action
              {correlationHref ? (
                <>
                  {' · '}
                  <Link href={correlationHref(group.correlationId)} className="underline-offset-4 hover:underline">
                    show only these
                  </Link>
                </>
              ) : (
                <> · {shortId(group.correlationId)}</>
              )}
            </p>
            <div className="ml-4 divide-y border-l">
              {group.rows.map((view) => (
                <ActivityRow key={view.id} view={view} showItem={showItem} />
              ))}
            </div>
          </div>
        ) : (
          group.rows.map((view) => <ActivityRow key={view.id} view={view} showItem={showItem} />)
        ),
      )}
    </div>
  );
}
