'use client';

/**
 * WID-3: question, choice, form and confirm cards for the assistant chat. Each card is a compiled
 * component for a spec in chat-card-specs.ts; the run waits on the card until the user answers or
 * dismisses it (WidgetToolCall hands the answer to the chat client, which resumes the run).
 *
 * All text from the agent (questions, labels, options) is rendered as React text, never as markup.
 * Answered and dismissed cards render locked with the outcome.
 */
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  askChoiceSpec,
  askChoiceSpecV1,
  askConfirmSpec,
  askFormSpec,
  askQuestionSpec,
  type AskChoiceAnswer,
  type AskChoiceProps,
  type AskConfirmAnswer,
  type AskConfirmProps,
  type AskFormAnswer,
  type AskFormField,
  type AskFormProps,
  type AskQuestionAnswer,
  type AskQuestionProps,
} from './chat-card-specs';
import {
  checkedChoiceIds,
  choiceBounds,
  choiceDraft,
  choiceLabel,
  choiceLabels,
  confirmDraft,
  draftChoiceIds,
  formDraft,
  formValueText,
  initialChoiceDraft,
  initialFormDraft,
  questionDraft,
  type ChoiceDraft,
  type FormDraft,
} from './chat-card-drafts';
import type { WidgetComponentProps, WidgetDefinition, WidgetStatus } from './widget-types';

const inputClass =
  'w-full rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

function CardFrame({
  kind,
  title,
  detail,
  status,
  busy,
  onDismiss,
  children,
}: {
  kind: string;
  title: string;
  detail?: string;
  status: WidgetStatus;
  busy?: boolean;
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  const titleId = React.useId();
  return (
    <section
      role="group"
      aria-labelledby={titleId}
      className="space-y-2 rounded-lg border bg-card p-3 text-sm"
      data-card={kind}
      data-card-status={status}
      data-busy={busy ? 'true' : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <p id={titleId} className="font-medium whitespace-pre-wrap">
          {title}
        </p>
        {onDismiss && (
          <Button type="button" size="sm" variant="ghost" onClick={onDismiss} data-action="dismiss">
            Dismiss
          </Button>
        )}
      </div>
      {detail && <p className="whitespace-pre-wrap text-muted-foreground">{detail}</p>}
      {children}
      {busy && <p className="text-xs text-muted-foreground" data-card-note="sending">Sending…</p>}
      {status === 'dismissed' && (
        <p className="text-xs text-muted-foreground" data-card-note="dismissed">
          Dismissed without an answer.
        </p>
      )}
    </section>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-destructive" data-field-error>
      {message}
    </p>
  );
}

// ---------------------------------------------------------------------------------------------

export function QuestionCard({ props, status, answer, onAnswer, onDismiss, busy }: WidgetComponentProps<AskQuestionProps, AskQuestionAnswer>) {
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState<string | undefined>();
  const inputId = React.useId();
  const errorId = `${inputId}-error`;
  const locked = !onAnswer;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!onAnswer) return;
    const draft = questionDraft(text, props.maxLength);
    if (!draft.ok) return setError(draft.errors.text);
    setError(undefined);
    onAnswer(draft.answer);
  };
  return (
    <CardFrame kind="question" title={props.question} detail={props.detail} status={status} busy={busy} onDismiss={onDismiss}>
      {status === 'answered' && answer ? (
        <p className="whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5" data-card-answer>
          {answer.text}
        </p>
      ) : status === 'pending' ? (
        <form className="space-y-2" onSubmit={submit}>
          <label htmlFor={inputId} className="sr-only">
            Answer
          </label>
          {props.multiline ? (
            <textarea
              id={inputId}
              className={`${inputClass} min-h-16`}
              value={text}
              placeholder={props.placeholder}
              maxLength={props.maxLength}
              disabled={locked}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => setText(e.target.value)}
            />
          ) : (
            <input
              id={inputId}
              type="text"
              className={inputClass}
              value={text}
              placeholder={props.placeholder}
              maxLength={props.maxLength}
              disabled={locked}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => setText(e.target.value)}
            />
          )}
          <FieldError id={errorId} message={error} />
          <Button type="submit" size="sm" disabled={locked || !text.trim()}>
            Send answer
          </Button>
        </form>
      ) : null}
    </CardFrame>
  );
}

// ---------------------------------------------------------------------------------------------

export function ChoiceCard({ props, status, answer, onAnswer, onDismiss, busy }: WidgetComponentProps<AskChoiceProps, AskChoiceAnswer>) {
  const multi = props.multiSelect === true;
  const [selected, setSelected] = React.useState<ChoiceDraft>(() => initialChoiceDraft(props));
  const [error, setError] = React.useState<string | undefined>();
  const name = React.useId();
  const locked = !onAnswer || status !== 'pending';
  const bounds = choiceBounds(props);
  const chosen = draftChoiceIds(selected);
  // B1: answered cards (incl. history replay) tick the stored answer; the draft only drives a pending card.
  const checked = checkedChoiceIds(status, answer, selected);
  const inBounds = multi ? chosen.length >= bounds.min && chosen.length <= bounds.max : chosen.length === 1;
  const recommendedIds = Array.isArray(props.recommended) ? props.recommended : props.recommended === undefined ? [] : [props.recommended];
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!onAnswer) return;
    const draft = choiceDraft(props, selected);
    if (!draft.ok) return setError(draft.errors.choices ?? draft.errors.choice);
    setError(undefined);
    onAnswer(draft.answer);
  };
  const answeredText =
    answer === undefined
      ? undefined
      : multi && 'choices' in answer
        ? `Chosen: ${choiceLabels(props, answer.choices)}`
        : 'choice' in answer
          ? `Chosen: ${choiceLabel(props, answer.choice) ?? answer.choice}`
          : undefined;
  return (
    <CardFrame kind="choice" title={props.question} detail={props.detail} status={status} busy={busy} onDismiss={onDismiss}>
      <form className="space-y-2" onSubmit={submit}>
        <fieldset className="space-y-1" disabled={locked}>
          <legend className="sr-only">Options</legend>
          {props.options.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 has-[:checked]:border-primary"
              data-option={option.id}
              data-recommended={recommendedIds.includes(option.id) ? 'true' : undefined}
            >
              {multi ? (
                <input
                  type="checkbox"
                  name={`${name}-multi`}
                  value={option.id}
                  checked={checked.includes(option.id)}
                  onChange={(e) => setSelected(e.target.checked ? [...chosen, option.id] : chosen.filter((id) => id !== option.id))}
                  className="mt-0.5"
                  aria-invalid={error ? true : undefined}
                />
              ) : (
                <input
                  type="radio"
                  name={name}
                  value={option.id}
                  checked={checked.includes(option.id)}
                  onChange={() => setSelected(option.id)}
                  className="mt-0.5"
                  aria-invalid={error ? true : undefined}
                />
              )}
              <span className="flex flex-col">
                <span>
                  {option.label}
                  {recommendedIds.includes(option.id) && (
                    <span className="ml-2 rounded bg-muted px-1.5 text-xs text-muted-foreground">Recommended</span>
                  )}
                </span>
                {option.description && <span className="text-xs text-muted-foreground">{option.description}</span>}
              </span>
            </label>
          ))}
        </fieldset>
        <FieldError id={`${name}-error`} message={error} />
        {status === 'pending' && (
          <div className="space-y-1">
            {multi && (
              <p className="text-xs text-muted-foreground" data-choice-counter>
                {`${chosen.length} of ${bounds.max} selected`}
              </p>
            )}
            <Button type="submit" size="sm" disabled={locked || !inBounds}>
              Choose
            </Button>
          </div>
        )}
        {status === 'answered' && answeredText !== undefined && (
          <p className="text-xs text-muted-foreground" data-card-answer>
            {answeredText}
          </p>
        )}
      </form>
    </CardFrame>
  );
}

// ---------------------------------------------------------------------------------------------

function FormFieldInput({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  field: AskFormField;
  value: string | string[];
  error?: string;
  disabled: boolean;
  onChange: (value: string | string[]) => void;
}) {
  const id = React.useId();
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  const required = field.required !== false;
  const describedBy = [field.help ? helpId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined;
  const ticks = Array.isArray(value) ? value : [];
  const textValue = typeof value === 'string' ? value : '';
  const common = {
    id,
    name: field.name,
    className: inputClass,
    disabled,
    required,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
  } as const;
  return (
    <div className="space-y-1" data-field={field.name} data-field-type={field.type}>
      {field.type === 'multiSelect' ? (
        <fieldset
          className="space-y-1"
          disabled={disabled}
          data-field-group={field.name}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        >
          <legend className="text-xs font-medium">
            {field.label}
            {!required && <span className="ml-1 text-muted-foreground">(optional)</span>}
          </legend>
          {field.options?.map((o) => (
            <label
              key={o.value}
              className="flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 has-[:checked]:border-primary"
              data-option={o.value}
            >
              <input
                type="checkbox"
                name={`${field.name}.${o.value}`}
                value={o.value}
                checked={ticks.includes(o.value)}
                aria-invalid={error ? true : undefined}
                onChange={(e) => onChange(e.target.checked ? [...ticks, o.value] : ticks.filter((v) => v !== o.value))}
                className="mt-0.5"
              />
              <span>{o.label}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <>
          <label htmlFor={id} className="text-xs font-medium">
            {field.label}
            {!required && <span className="ml-1 text-muted-foreground">(optional)</span>}
          </label>
          {field.type === 'select' ? (
            <select {...common} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
              <option value="">Choose…</option>
              {field.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : field.type === 'number' ? (
            <input
              {...common}
              type="number"
              inputMode={field.integer ? 'numeric' : 'decimal'}
              min={field.min}
              max={field.max}
              step={field.integer ? 1 : 'any'}
              placeholder={field.placeholder}
              value={textValue}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : field.multiline ? (
            <textarea
              {...common}
              className={`${inputClass} min-h-16`}
              maxLength={field.maxLength}
              placeholder={field.placeholder}
              value={textValue}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <input
              {...common}
              type="text"
              autoComplete="off"
              maxLength={field.maxLength}
              placeholder={field.placeholder}
              value={textValue}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </>
      )}
      {field.help && (
        <p id={helpId} className="text-xs text-muted-foreground">
          {field.help}
        </p>
      )}
      <FieldError id={errorId} message={error} />
    </div>
  );
}

export function FormCard({ props, status, answer, onAnswer, onDismiss, busy }: WidgetComponentProps<AskFormProps, AskFormAnswer>) {
  const [draft, setDraft] = React.useState<FormDraft>(() => initialFormDraft(props));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const locked = !onAnswer;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!onAnswer) return;
    const result = formDraft(props, draft);
    if (!result.ok) return setErrors(result.errors);
    setErrors({});
    onAnswer(result.answer);
  };
  return (
    <CardFrame kind="form" title={props.title} detail={props.detail} status={status} busy={busy} onDismiss={onDismiss}>
      {status === 'answered' && answer ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" data-card-answer>
          {props.fields.map((field) => (
            <React.Fragment key={field.name}>
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="whitespace-pre-wrap">{formValueText(field, answer.values[field.name])}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : status === 'pending' ? (
        <form className="space-y-3" onSubmit={submit} noValidate>
          {props.fields.map((field) => (
            <FormFieldInput
              key={field.name}
              field={field}
              value={draft[field.name] ?? (field.type === 'multiSelect' ? [] : '')}
              error={errors[field.name]}
              disabled={locked}
              onChange={(value) => setDraft((d) => ({ ...d, [field.name]: value }))}
            />
          ))}
          <Button type="submit" size="sm" disabled={locked}>
            {props.submitLabel ?? 'Submit'}
          </Button>
        </form>
      ) : null}
    </CardFrame>
  );
}

// ---------------------------------------------------------------------------------------------

export function ConfirmCard({ props, status, answer, onAnswer, onDismiss, busy }: WidgetComponentProps<AskConfirmProps, AskConfirmAnswer>) {
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | undefined>();
  const reasonId = React.useId();
  const errorId = `${reasonId}-error`;
  const locked = !onAnswer;
  const answerWith = (confirmed: boolean) => {
    if (!onAnswer) return;
    const draft = confirmDraft(props, confirmed, reason);
    if (!draft.ok) return setError(draft.errors.reason);
    setError(undefined);
    onAnswer(draft.answer);
  };
  return (
    <CardFrame kind="confirm" title={props.question} detail={props.detail} status={status} busy={busy} onDismiss={onDismiss}>
      {status === 'answered' && answer ? (
        <div className="space-y-1" data-card-answer data-confirmed={answer.confirmed ? 'true' : 'false'}>
          <p className="font-medium">{answer.confirmed ? (props.confirmLabel ?? 'Confirmed') : (props.cancelLabel ?? 'Cancelled')}</p>
          {answer.reason && <p className="whitespace-pre-wrap text-muted-foreground">{answer.reason}</p>}
        </div>
      ) : status === 'pending' ? (
        <div className="space-y-2">
          {props.reason && (
            <div className="space-y-1">
              <label htmlFor={reasonId} className="text-xs font-medium">
                Reason{props.reason === 'optional' && <span className="ml-1 text-muted-foreground">(optional)</span>}
              </label>
              <textarea
                id={reasonId}
                className={`${inputClass} min-h-12`}
                value={reason}
                disabled={locked}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => setReason(e.target.value)}
              />
              <FieldError id={errorId} message={error} />
            </div>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={props.destructive ? 'destructive' : 'default'}
              disabled={locked}
              onClick={() => answerWith(true)}
              data-action="confirm"
            >
              {props.confirmLabel ?? 'Confirm'}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => answerWith(false)} data-action="cancel">
              {props.cancelLabel ?? 'Cancel'}
            </Button>
          </div>
        </div>
      ) : null}
    </CardFrame>
  );
}

/** WID-3 card definitions for the assistant registry (same order as chatCardSpecs). */
export const chatCardDefinitions: WidgetDefinition[] = [
  { ...askQuestionSpec, component: QuestionCard },
  { ...askChoiceSpecV1, component: ChoiceCard },
  { ...askChoiceSpec, component: ChoiceCard },
  { ...askFormSpec, component: FormCard },
  { ...askConfirmSpec, component: ConfirmCard },
] as WidgetDefinition[];
