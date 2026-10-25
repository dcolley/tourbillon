'use client';

/**
 * WID-2: the Board approval card in the assistant chat (`approvalCard` widget).
 *
 * Reads the approval from `GET /api/approvals/:id/card` and answers through
 * `POST /api/approvals/:id/decide`: the same Board route, claim and wake as the /approval page, so
 * the approval can be answered from either place and only the first answer applies (the other gets
 * "already decided" and the card refreshes). Links and files are opened on the approval page,
 * where opening is recorded; a mustOpen item has to be opened there before answering.
 */
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  APPROVAL_STATUS_LABEL,
  approvalCardDecisionBody,
  approvalCardErrorText,
  approvalCardNeedsReason,
  type ApprovalCardData,
  type ApprovalCardInput,
} from '@/lib/approval-card-view';
import type { WidgetComponentProps } from './widget-types';

export const SECRET_REFUSAL =
  'This question asks for a secret. Secret answers must be encrypted on your device, which is not supported yet. Decline it, or answer through a client that supports encrypted answers.';

function optionText(card: ApprovalCardData, value: unknown): string {
  if (card.answerType === 'binary') return value === 'approve' ? 'Approve' : value === 'reject' ? 'Reject' : String(value);
  if (Array.isArray(value)) return value.map((v) => optionText(card, v)).join(', ');
  return card.options.find((o) => o.value === value)?.label ?? (typeof value === 'string' ? value : JSON.stringify(value));
}

/** Initial answer: the request default (never the recommendation). */
export function initialCardValue(card: ApprovalCardData): unknown {
  if (card.default === undefined) return card.answerType === 'multi' ? [] : undefined;
  if (card.answerType === 'number' && typeof card.default === 'number') return String(card.default);
  return card.default;
}

export interface ApprovalCardBodyProps {
  card: ApprovalCardData;
  draft: ApprovalCardInput;
  busy?: boolean;
  error?: string | null;
  onDraftChange: (draft: ApprovalCardInput) => void;
  /** Send the answer; `value` overrides the draft (binary buttons). */
  onSubmit: (input: ApprovalCardInput) => void;
  onRefresh?: () => void;
}

/** Stateless card body (tested with react-dom/server). */
export function ApprovalCardBody({ card, draft, busy, error, onDraftChange, onSubmit, onRefresh }: ApprovalCardBodyProps) {
  const pending = card.status === 'pending';
  const idBase = `approval-card-${card.id}`;
  const mustOpen = card.items.filter((i) => i.mustOpen && !i.opened);
  const recs = new Set(
    card.recommended ? (Array.isArray(card.recommended.value) ? card.recommended.value : [card.recommended.value]).map(String) : [],
  );
  const selected = new Set((Array.isArray(draft.value) ? draft.value : draft.value === undefined ? [] : [draft.value]).map(String));
  const needsReason = card.answerType === 'binary' ? card.reasonRequired.length > 0 : approvalCardNeedsReason(card, draft.value);
  const set = (patch: Partial<ApprovalCardInput>) => onDraftChange({ ...draft, ...patch });

  return (
    <div className="space-y-2 rounded-lg border bg-card p-3 text-sm" data-approval-card={card.id} data-approval-status={card.status}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Board approval</p>
          <p className="font-medium" data-testid="approval-card-title">{card.title}</p>
          {card.subtitle ? <p className="text-muted-foreground">{card.subtitle}</p> : null}
          <p className="text-xs text-muted-foreground">
            Requested by {card.requestedBy ?? 'Unknown agent'}
            {card.typed ? ` · ${card.answerType} question` : ''} ·{' '}
            <a href={card.detailsPath} className="hover:underline" data-testid="approval-card-details">
              Open approval page
            </a>
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="rounded border px-1.5 py-0.5 text-xs" data-testid="approval-card-status">
            {APPROVAL_STATUS_LABEL[card.status] ?? card.status}
          </span>
          {card.risk?.level ? (
            <span className="rounded border px-1.5 py-0.5 text-xs" data-testid="approval-card-risk">
              Risk: {card.risk.level}
              {card.risk.reversible === false ? ' · irreversible' : card.risk.reversible ? ' · reversible' : ''}
            </span>
          ) : null}
        </div>
      </div>

      {card.deadline ? (
        <p className="text-xs text-muted-foreground" data-testid="approval-card-deadline">
          Deadline: <time dateTime={card.deadline}>{card.deadline.replace('T', ' ').slice(0, 16)} UTC</time>
          {pending ? ' · expires with no answer if undecided' : ''}
        </p>
      ) : null}

      {card.summary ? <p className="text-muted-foreground">{card.summary}</p> : null}

      {card.recommended ? (
        <div className="rounded-md border border-primary/40 bg-primary/5 px-2 py-1" data-testid="approval-card-recommended">
          <span className="font-medium">Recommended: {optionText(card, card.recommended.value)}</span>
          <span className="text-muted-foreground"> — {card.recommended.reason}</span>
        </div>
      ) : null}

      {card.context ? (
        <details className="rounded-md border px-2 py-1">
          <summary className="cursor-pointer text-xs text-muted-foreground">Context</summary>
          <div className="mt-1 whitespace-pre-wrap">{card.context}</div>
        </details>
      ) : null}

      {card.items.length > 0 ? (
        <div className="rounded-md border px-2 py-1" data-testid="approval-card-items">
          <p className="text-xs text-muted-foreground">Links and files (open them on the approval page)</p>
          <ul>
            {card.items.map((i) => (
              <li key={i.ref} data-item-ref={i.ref} data-opened={i.opened ? 'true' : 'false'}>
                {i.label}
                {i.mustOpen ? (
                  <span className="ml-2 text-xs text-amber-700">{i.opened ? 'opened' : 'open before answering'}</span>
                ) : i.opened ? (
                  <span className="ml-2 text-xs text-muted-foreground">opened</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!pending ? (
        <p className="rounded-md bg-muted/40 px-2 py-1" data-testid="approval-card-response">
          {APPROVAL_STATUS_LABEL[card.response?.status ?? card.status] ?? card.response?.status ?? card.status}
          {card.response?.answer ? ` · ${card.response.answer}` : ''}
          {card.response?.decidedBy ? ` · by ${card.response.decidedBy}` : ''}
          {card.response?.reason ? <span className="block text-muted-foreground">Reason: {card.response.reason}</span> : null}
        </p>
      ) : null}

      {error ? (
        <p className="rounded-md border border-destructive/50 px-2 py-1 text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {pending ? (
        <div className="space-y-2" data-testid="approval-card-controls">
          {mustOpen.length > 0 ? (
            <p className="text-xs text-amber-700" data-testid="approval-card-must-open">
              Open {mustOpen.map((i) => `"${i.label}"`).join(', ')} on the{' '}
              <a href={card.detailsPath} className="underline">
                approval page
              </a>{' '}
              before answering.
            </p>
          ) : null}

          {card.answerType === 'secret' ? (
            <p className="rounded-md border border-amber-600/40 px-2 py-1 text-amber-800" data-testid="approval-card-secret">
              {SECRET_REFUSAL}
            </p>
          ) : null}

          {card.answerType === 'single' || card.answerType === 'multi' ? (
            <fieldset className="space-y-1" disabled={busy}>
              <legend className="text-xs font-medium">
                {card.answerType === 'multi' ? 'Pick one or more' : 'Pick one'}
                {card.answerType === 'multi' && (card.bounds.minItems !== undefined || card.bounds.maxItems !== undefined)
                  ? ` (${card.bounds.minItems ?? 0}–${card.bounds.maxItems ?? card.options.length})`
                  : ''}
              </legend>
              {card.options.map((o) => {
                const key = String(o.value);
                const checked = selected.has(key);
                return (
                  <label key={key} className={`flex items-start gap-2 rounded px-1 ${recs.has(key) ? 'bg-primary/5 ring-1 ring-primary/40' : ''}`}>
                    <input
                      type={card.answerType === 'multi' ? 'checkbox' : 'radio'}
                      name={`${idBase}-value`}
                      value={key}
                      checked={checked}
                      onChange={() => {
                        if (card.answerType === 'single') set({ value: o.value });
                        else {
                          const cur = Array.isArray(draft.value) ? draft.value : [];
                          set({ value: checked ? cur.filter((v) => String(v) !== key) : [...cur, o.value] });
                        }
                      }}
                      className="mt-1"
                    />
                    <span>
                      {o.label}
                      {recs.has(key) ? <span className="ml-2 text-xs text-primary">recommended</span> : null}
                      {o.description ? <span className="block text-xs text-muted-foreground">{o.description}</span> : null}
                    </span>
                  </label>
                );
              })}
            </fieldset>
          ) : null}

          {card.answerType === 'number' ? (
            <label className="block space-y-1">
              <span className="text-xs font-medium">
                Answer
                {card.bounds.min !== undefined || card.bounds.max !== undefined
                  ? ` (${card.bounds.min ?? '…'} to ${card.bounds.max ?? '…'}${card.bounds.step !== undefined ? `, step ${card.bounds.step}` : ''}${typeof card.bounds.unit === 'string' ? ` ${card.bounds.unit}` : ''})`
                  : ''}
              </span>
              <input
                type="number"
                className="w-full rounded-md border bg-background px-2 py-1"
                min={card.bounds.min as number | undefined}
                max={card.bounds.max as number | undefined}
                step={(card.bounds.step as number | undefined) ?? 'any'}
                value={typeof draft.value === 'string' || typeof draft.value === 'number' ? String(draft.value) : ''}
                onChange={(e) => set({ value: e.target.value })}
                disabled={busy}
              />
            </label>
          ) : null}

          {card.answerType === 'text' ? (
            <label className="block space-y-1">
              <span className="text-xs font-medium">
                Answer{card.bounds.maxLength !== undefined ? ` (max ${card.bounds.maxLength} characters)` : ''}
              </span>
              <textarea
                className="w-full rounded-md border bg-background px-2 py-1"
                rows={2}
                maxLength={card.bounds.maxLength as number | undefined}
                value={typeof draft.value === 'string' ? draft.value : ''}
                onChange={(e) => set({ value: e.target.value })}
                disabled={busy}
              />
            </label>
          ) : null}

          <label className="block space-y-1">
              <span className="text-xs font-medium">
                Reason
                {card.reasonRequired.length > 0 ? (
                  <span className="ml-1 font-normal text-muted-foreground" data-testid="approval-card-reason-required">
                    (required for: {card.reasonRequired.map((v) => optionText(card, card.answerType === 'number' ? Number(v) : v)).join(', ')})
                  </span>
                ) : null}
              </span>
              <textarea
                className="w-full rounded-md border bg-background px-2 py-1"
                rows={2}
                placeholder={needsReason && card.answerType !== 'binary' ? 'Required for this answer' : 'Optional reason (posted to linked issues)'}
                value={draft.reason ?? ''}
                onChange={(e) => set({ reason: e.target.value })}
                disabled={busy}
              />
            </label>

          <div className="flex flex-wrap gap-2">
            {card.answerType === 'binary' ? (
              <>
                <Button type="button" size="sm" disabled={busy} data-action="approve" onClick={() => onSubmit({ ...draft, value: 'approve' })}>
                  Approve
                </Button>
                <Button type="button" size="sm" variant="destructive" disabled={busy} data-action="reject" onClick={() => onSubmit({ ...draft, value: 'reject' })}>
                  Reject
                </Button>
              </>
            ) : card.answerType === 'secret' ? null : (
              <Button type="button" size="sm" disabled={busy} data-action="answer" onClick={() => onSubmit(draft)}>
                Send answer
              </Button>
            )}
            {card.typed ? (
              <Button type="button" size="sm" variant="outline" disabled={busy} data-action="decline" onClick={() => onSubmit({ reason: draft.reason, decline: true })}>
                Decline
              </Button>
            ) : null}
            {onRefresh ? (
              <Button type="button" size="sm" variant="ghost" disabled={busy} data-action="refresh" onClick={onRefresh}>
                Refresh
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

type Load = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'ready'; card: ApprovalCardData };

/** Fetch the card view; null body on a network failure. */
async function fetchCard(approvalId: string): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}/card`, { cache: 'no-store', credentials: 'same-origin' });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

/** The registered widget: loads the card, keeps the draft, sends the answer. */
export function ApprovalCardWidget({ props }: WidgetComponentProps<{ approvalId: string }, unknown>) {
  const { approvalId } = props;
  const [load, setLoad] = React.useState<Load>({ phase: 'loading' });
  const [draft, setDraft] = React.useState<ApprovalCardInput>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const seeded = React.useRef(false);

  const applyResult = React.useCallback((r: { status: number; body: unknown } | null) => {
    if (!r) {
      setLoad((l) => (l.phase === 'ready' ? l : { phase: 'error', message: 'The approval could not be loaded.' }));
      return;
    }
    if (r.status !== 200 || !r.body) {
      setLoad({ phase: 'error', message: approvalCardErrorText(r.status, r.body) });
      return;
    }
    const card = r.body as ApprovalCardData;
    if (!seeded.current) {
      seeded.current = true;
      setDraft({ value: initialCardValue(card) });
    }
    setLoad({ phase: 'ready', card });
  }, []);

  const refresh = React.useCallback(() => fetchCard(approvalId).then(applyResult), [approvalId, applyResult]);

  React.useEffect(() => {
    let live = true;
    const load = () => {
      void fetchCard(approvalId).then((r) => {
        if (live) applyResult(r);
      });
    };
    load();
    // Decided elsewhere (the /approval page, another tab): refresh when the chat is looked at again.
    window.addEventListener('focus', load);
    return () => {
      live = false;
      window.removeEventListener('focus', load);
    };
  }, [approvalId, applyResult]);

  const submit = React.useCallback(
    async (input: ApprovalCardInput) => {
      if (load.phase !== 'ready' || busy) return;
      const built = approvalCardDecisionBody(load.card, input);
      if (!built.ok) return setError(built.error);
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}/decide`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(built.body),
        });
        if (!res.ok) setError(approvalCardErrorText(res.status, await res.json().catch(() => null)));
      } catch {
        setError('The answer could not be sent. Try again.');
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [approvalId, busy, load, refresh],
  );

  if (load.phase === 'loading') {
    return (
      <div className="rounded-lg border p-3 text-sm text-muted-foreground" data-approval-card={approvalId} data-approval-status="loading">
        Loading approval…
      </div>
    );
  }
  if (load.phase === 'error') {
    return (
      <div className="rounded-lg border p-3 text-sm" data-approval-card={approvalId} data-approval-status="error">
        <p className="text-destructive">{load.message}</p>
        <a href={`/approval/${encodeURIComponent(approvalId)}`} className="text-xs hover:underline">
          Open approval page
        </a>
      </div>
    );
  }
  return (
    <ApprovalCardBody
      card={load.card}
      draft={draft}
      busy={busy}
      error={error}
      onDraftChange={setDraft}
      onSubmit={(i) => void submit(i)}
      onRefresh={() => void refresh()}
    />
  );
}
