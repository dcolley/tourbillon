/**
 * APR-2: the Board's approval card for a pending approval. Shows the question (or the legacy
 * title/summary), the recommended answer (highlighted, never pre-selected), collapsed context,
 * links and attachments through `/o/<token>` (opening is recorded), risk, deadline, and answer
 * controls for the question's answer type. Posts to `/api/approvals/:id/decide`.
 */
import Link from 'next/link';
import type { HitlRequest } from '@tourbillon/shared/hitl';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownContent } from '@/components/markdown-content';
import { StatusBadge } from '@/lib/status-badges';

export interface ApprovalCardData {
  id: string;
  type: string;
  status: string;
  payload: unknown;
  createdAt: Date;
  issueIds: string[];
  hitlyApprovalId: string | null;
  hitlyError: string | null;
  hitlRequest: unknown;
  deadline: Date | null;
}

export interface LinkedIssueRow {
  id: string;
  identifier: string;
  title: string;
  boardApprovalId: string | null;
}

const RISK_CLASS: Record<string, string> = {
  low: 'border-emerald-600/40 text-emerald-700',
  medium: 'border-amber-600/40 text-amber-700',
  high: 'border-orange-600/50 text-orange-700',
  critical: 'border-destructive text-destructive',
};

function optionLabel(req: HitlRequest, value: unknown): string {
  if (req.answerType === 'binary') return value === 'approve' ? 'Approve' : value === 'reject' ? 'Reject' : String(value);
  if (Array.isArray(value)) return value.map((v) => optionLabel(req, v)).join(', ');
  const o = req.options?.find((x) => x.value === value);
  return o ? o.label : JSON.stringify(value);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ApprovalQuestionCard({
  approval,
  agent,
  linkedIssues,
  linkPaths,
  returnTo,
  error,
  showDetailsLink = true,
}: {
  approval: ApprovalCardData;
  agent: { name: string } | null;
  linkedIssues: LinkedIssueRow[];
  /** ref → `/o/<token>` for this reviewer. */
  linkPaths: Record<string, string>;
  returnTo?: string;
  error?: string;
  showDetailsLink?: boolean;
}) {
  const payload = (approval.payload ?? {}) as { title?: string; summary?: string };
  const req = (approval.hitlRequest ?? null) as HitlRequest | null;
  const answerType = req?.answerType ?? 'binary';
  const title = req?.question ?? payload.title ?? approval.type;
  const reasonFor = new Set((req?.reasonRequired ?? (answerType === 'binary' && req ? ['reject'] : [])).map(String));
  const links = req?.context?.links ?? [];
  const attachments = req?.context?.attachments ?? [];
  const hasItems = links.length + attachments.length > 0;
  const formId = `approval-form-${approval.id}`;
  const bounds = (req?.bounds ?? {}) as Record<string, number | string | undefined>;
  const deadlinePassed = approval.deadline ? approval.deadline.getTime() <= Date.now() : false;

  return (
    <Card data-approval-id={approval.id}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-medium">{title}</p>
            {req && payload.title && payload.title !== req.question ? (
              <p className="text-sm text-muted-foreground">{payload.title}</p>
            ) : null}
            <p className="mt-0.5 text-sm text-muted-foreground">
              Requested by {agent?.name ?? 'Unknown agent'} · {new Date(approval.createdAt).toLocaleDateString()}
              {req ? ` · ${answerType} question` : ''}
              {showDetailsLink ? (
                <>
                  {' · '}
                  <Link href={`/approval/${approval.id}`} className="hover:underline">
                    Details
                  </Link>
                </>
              ) : null}
            </p>
            {approval.hitlyApprovalId && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                Sent to HITLy · <span className="font-mono">{approval.hitlyApprovalId}</span>
              </p>
            )}
            {approval.hitlyError && (
              <p className="mt-0.5 text-xs text-destructive">HITLy ingest error: {approval.hitlyError}</p>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <StatusBadge status={approval.status} />
            {req?.risk?.level ? (
              <span className={`rounded border px-1.5 py-0.5 text-xs ${RISK_CLASS[req.risk.level] ?? ''}`}>
                Risk: {req.risk.level}
                {req.risk.reversible === false ? ' · irreversible' : req.risk.reversible ? ' · reversible' : ''}
              </span>
            ) : null}
          </div>
        </div>

        {approval.deadline ? (
          <p className={`text-xs ${deadlinePassed ? 'text-destructive' : 'text-muted-foreground'}`}>
            Deadline: <time dateTime={approval.deadline.toISOString()}>{approval.deadline.toISOString().replace('T', ' ').slice(0, 16)} UTC</time>
            {deadlinePassed ? ' (passed; this request expires)' : ' · expires with no answer if undecided'}
          </p>
        ) : null}

        {!req && payload.summary ? <p className="text-sm text-muted-foreground">{payload.summary}</p> : null}

        {req?.recommended ? (
          <div className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm" data-testid="recommended">
            <span className="font-medium">Recommended: {optionLabel(req, req.recommended.value)}</span>
            <span className="text-muted-foreground"> — {req.recommended.reason}</span>
          </div>
        ) : null}

        {req?.context?.markdown ? (
          <details className="rounded-md border px-3 py-2 text-sm">
            <summary className="cursor-pointer text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Context
            </summary>
            <div className="mt-2">
              <MarkdownContent content={req.context.markdown} showModeToggle={false} />
            </div>
          </details>
        ) : null}

        {hasItems ? (
          <div className="rounded-md border px-3 py-2 text-sm">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Links and files</p>
            <ul className="mt-1 space-y-1">
              {links.map((l) => (
                <li key={l.ref}>
                  <a href={linkPaths[l.ref]} target="_blank" rel="noreferrer noopener" className="hover:underline">
                    {l.label}
                  </a>
                  {l.mustOpen ? <span className="ml-2 text-xs text-amber-700">open before answering</span> : null}
                  {l.description ? <span className="block text-xs text-muted-foreground">{l.description}</span> : null}
                </li>
              ))}
              {attachments.map((a) => (
                <li key={a.ref}>
                  <a href={linkPaths[a.ref]} target="_blank" rel="noreferrer noopener" className="hover:underline">
                    {a.name}
                  </a>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {a.mediaType} · {formatBytes(a.size)}
                  </span>
                  {a.mustOpen ? <span className="ml-2 text-xs text-amber-700">open before answering</span> : null}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              Opening a link or file is recorded (which item, and when) and included in the answer sent to the requesting agent.
            </p>
          </div>
        ) : null}

        {linkedIssues.length > 0 && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Halted issues</p>
            <ul className="mt-1 space-y-1">
              {linkedIssues.map((issue) => (
                <li key={issue.id}>
                  <Link href={`/issue/${issue.id}`} className="hover:underline">
                    <span className="font-mono text-xs">{issue.identifier}</span>
                    <span className="text-muted-foreground"> — {issue.title}</span>
                    {issue.boardApprovalId === approval.id ? <span className="ml-2 text-xs text-amber-700">halted</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error ? (
          <p className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        {approval.status === 'pending' ? (
          <form id={formId} action={`/api/approvals/${approval.id}/decide`} method="POST" className="space-y-3">
            {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
            <AnswerControls req={req} approvalId={approval.id} bounds={bounds} />
            <div className="space-y-2">
              <Label htmlFor={`approval-reason-${approval.id}`}>
                Reason
                {reasonFor.size > 0 ? (
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    (required for: {[...reasonFor].map((v) => (req ? optionLabel(req, answerType === 'number' ? Number(v) : v) : v)).join(', ')})
                  </span>
                ) : null}
              </Label>
              <Textarea
                id={`approval-reason-${approval.id}`}
                name="reason"
                rows={3}
                placeholder="Optional reason (posted to linked issues)"
                className="resize-y"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {answerType === 'binary' ? (
                <>
                  <Button type="submit" name="decision" value="approved" size="sm">
                    Approve
                  </Button>
                  <Button type="submit" name="decision" value="rejected" size="sm" variant="destructive">
                    Reject
                  </Button>
                </>
              ) : answerType === 'secret' ? null : (
                <Button type="submit" name="status" value="answered" size="sm">
                  Submit answer
                </Button>
              )}
              {req ? (
                <Button type="submit" name="status" value="declined" size="sm" variant="outline" formNoValidate>
                  Decline
                </Button>
              ) : null}
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AnswerControls({
  req,
  approvalId,
  bounds,
}: {
  req: HitlRequest | null;
  approvalId: string;
  bounds: Record<string, number | string | undefined>;
}) {
  if (!req || req.answerType === 'binary') return null;
  const recommended = req.recommended?.value;
  const name = 'value';
  switch (req.answerType) {
    case 'single':
    case 'multi': {
      const multi = req.answerType === 'multi';
      const defaults = new Set(Array.isArray(req.default) ? req.default : req.default !== undefined ? [req.default] : []);
      const recs = new Set(Array.isArray(recommended) ? recommended : recommended !== undefined ? [recommended] : []);
      return (
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">
            {multi ? 'Pick one or more' : 'Pick one'}
            {multi && (bounds.minItems !== undefined || bounds.maxItems !== undefined) ? (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                ({bounds.minItems ?? 0}–{bounds.maxItems ?? (req.options?.length ?? 0)})
              </span>
            ) : null}
          </legend>
          {(req.options ?? []).map((o) => (
            <label key={o.value} className={`flex items-start gap-2 rounded px-2 py-1 text-sm ${recs.has(o.value) ? 'bg-primary/5 ring-1 ring-primary/40' : ''}`}>
              <input type={multi ? 'checkbox' : 'radio'} name={name} value={o.value} defaultChecked={defaults.has(o.value)} className="mt-1" />
              <span>
                {o.label}
                {recs.has(o.value) ? <span className="ml-2 text-xs text-primary">recommended</span> : null}
                {o.description ? <span className="block text-xs text-muted-foreground">{o.description}</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
      );
    }
    case 'number':
      return (
        <div className="space-y-1">
          <Label htmlFor={`approval-value-${approvalId}`}>
            Answer
            {bounds.min !== undefined || bounds.max !== undefined ? (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                ({bounds.min ?? '…'} to {bounds.max ?? '…'}
                {bounds.step !== undefined ? `, step ${bounds.step}` : ''}
                {typeof bounds.unit === 'string' ? ` ${bounds.unit}` : ''})
              </span>
            ) : null}
          </Label>
          <Input
            id={`approval-value-${approvalId}`}
            name={name}
            type="number"
            min={bounds.min as number | undefined}
            max={bounds.max as number | undefined}
            step={(bounds.step as number | undefined) ?? 'any'}
            defaultValue={typeof req.default === 'number' ? req.default : undefined}
          />
        </div>
      );
    case 'text':
      return (
        <div className="space-y-1">
          <Label htmlFor={`approval-value-${approvalId}`}>
            Answer
            {bounds.maxLength !== undefined ? (
              <span className="ml-1 text-xs font-normal text-muted-foreground">(max {bounds.maxLength} characters)</span>
            ) : null}
          </Label>
          <Textarea
            id={`approval-value-${approvalId}`}
            name={name}
            rows={2}
            maxLength={bounds.maxLength as number | undefined}
            defaultValue={typeof req.default === 'string' ? req.default : undefined}
          />
          {typeof bounds.pattern === 'string' ? (
            <p className="text-xs text-muted-foreground">
              Must match <code>{bounds.pattern}</code> (whole answer).
            </p>
          ) : null}
        </div>
      );
    case 'secret':
      return (
        <p className="rounded-md border border-amber-600/40 px-3 py-2 text-sm text-amber-800">
          This question asks for a secret. Secret answers must be encrypted on your device, which this dashboard does not
          support yet. Decline it, or answer through a client that supports encrypted answers.
        </p>
      );
    default:
      return null;
  }
}
