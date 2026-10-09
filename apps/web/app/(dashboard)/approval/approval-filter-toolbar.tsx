'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { APPROVAL_STATUS_FILTERS } from './approval-filter';

/**
 * Search + status filter toolbar for the Approvals list.
 * URL query (`?q=&status=`) is the source of truth so refresh/back/forward
 * keep the filter (issue-list pattern: Suspense boundary + router.replace);
 * navigation stays on /approval so the active-company cookie
 * (`active_company_id`) scope is unchanged. `payload.hitlyResumeToken` is
 * never projected or rendered anywhere on this page.
 */
export function ApprovalFilterToolbar({
  status,
  query,
}: {
  status: string;
  query: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [draftStatus, setDraftStatus] = useState(status);
  const [draftQuery, setDraftQuery] = useState(query);

  // Keep local draft in sync when the URL changes (back/forward, external nav).
  useEffect(() => {
    setDraftStatus(status);
    setDraftQuery(query);
  }, [status, query]);

  const apply = (nextStatus: string, nextQuery: string) => {
    setDraftStatus(nextStatus);
    setDraftQuery(nextQuery);
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('status', nextStatus);
    if (nextQuery) params.set('q', nextQuery);
    else params.delete('q');
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `/approval?${qs}` : '/approval', { scroll: false });
    });
  };

  const isDirty = draftStatus !== status || draftQuery !== query;

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (isDirty || !isPending) apply(draftStatus, draftQuery);
      }}
    >
      <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          name="q"
          value={draftQuery}
          onChange={(e) => setDraftQuery(e.target.value)}
          placeholder="Search approvals (title, body, requester, issue)…"
          className="h-9 pl-8 text-sm"
          autoComplete="off"
        />
      </div>
      <Select value={draftStatus} onValueChange={(v) => apply(v, draftQuery)}>
        <SelectTrigger className="h-9 w-[170px]">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          {APPROVAL_STATUS_FILTERS.map((f) => (
            <SelectItem key={f.id} value={f.id}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </form>
  );
}
