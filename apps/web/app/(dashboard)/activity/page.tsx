import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ActivityFeed } from '@/components/activity/activity-feed';
import { getActiveCompanyOrNull } from '@/lib/company';
import { ACTIVITY_PAGE_LIMIT, listActivityActorOptions, listCompanyActivity } from '@/lib/activity';
import { ACTIVITY_ENTITY_TYPES, hasActiveFilters, parseActivityFilters } from '@/lib/activity-view';

const TYPE_LABELS: Record<string, string> = {
  issue: 'Issues',
  approval: 'Approvals',
  agent: 'Agents',
  project: 'Projects',
  goal: 'Goals',
  workspace: 'Workspace',
  llm_provider: 'LLM providers',
};

const fieldClass =
  'h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const company = await getActiveCompanyOrNull();
  if (!company) return null;
  const filters = parseActivityFilters(await searchParams);
  const [views, actorOptions] = await Promise.all([
    listCompanyActivity(company.id, filters),
    listActivityActorOptions(company.id),
  ]);
  const filtered = hasActiveFilters(filters);

  return (
    <div className="space-y-6">
      <PageHeader title="Activity" description="Audit log of agent, Board and system actions" />

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm" aria-label="Filter activity">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Item type</span>
          <select name="type" defaultValue={filters.raw.type} className={fieldClass}>
            <option value="">All items</option>
            {ACTIVITY_ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t] ?? t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Actor</span>
          <select name="actor" defaultValue={filters.raw.actor} className={fieldClass}>
            <option value="">Anyone</option>
            {actorOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">From (UTC)</span>
          <input type="date" name="from" defaultValue={filters.raw.from} className={fieldClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">To (UTC)</span>
          <input type="date" name="to" defaultValue={filters.raw.to} className={fieldClass} />
        </label>
        {filters.raw.correlation ? <input type="hidden" name="correlation" value={filters.raw.correlation} /> : null}
        <Button type="submit" size="sm">
          Apply
        </Button>
        {filtered ? (
          <Link href="/activity" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
            Clear filters
          </Link>
        ) : null}
      </form>

      {filters.correlationId ? (
        <p className="text-xs text-muted-foreground">Showing only rows from one action.</p>
      ) : null}

      <Card>
        <CardContent className="p-0">
          {views.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              {filtered
                ? 'No activity matches these filters.'
                : 'No activity yet. Actions like issue checkouts and updates will appear here.'}
            </p>
          ) : (
            <ActivityFeed
              views={views}
              correlationHref={(id) => `/activity?correlation=${encodeURIComponent(id)}`}
            />
          )}
        </CardContent>
      </Card>
      {views.length >= ACTIVITY_PAGE_LIMIT ? (
        <p className="text-xs text-muted-foreground">
          Showing the newest {ACTIVITY_PAGE_LIMIT} rows. Narrow the date range to see older activity.
        </p>
      ) : null}
    </div>
  );
}
