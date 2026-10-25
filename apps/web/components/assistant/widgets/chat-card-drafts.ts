/**
 * WID-3: pure helpers behind the chat cards (chat-cards.tsx): turn what the user typed or picked into
 * an answer, or say what is missing. The answer is then validated again by the registry and the
 * server with the spec's own checks (chat-card-specs.ts); these helpers only drive the card's UI.
 */
import {
  CONFIRM_REASON_MAX,
  formFieldIssues,
  QUESTION_MAX_ANSWER,
  type AskChoiceProps,
  type AskConfirmAnswer,
  type AskConfirmProps,
  type AskFormAnswer,
  type AskFormField,
  type AskFormProps,
  type AskFormValue,
} from './chat-card-specs';

export type DraftResult<A> = { ok: true; answer: A } | { ok: false; errors: Record<string, string> };

/** Message for an issue code (from formFieldIssues and the card checks); never echoes values. */
export function issueMessage(code: string, field?: Pick<AskFormField, 'min' | 'max' | 'maxLength'>): string {
  switch (code) {
    case 'required':
      return 'Required.';
    case 'too_long':
      return field?.maxLength ? `At most ${field.maxLength} characters.` : 'Too long.';
    case 'too_small':
      return field?.min !== undefined ? `At least ${field.min}.` : 'Too small.';
    case 'too_big':
      return field?.max !== undefined ? `At most ${field.max}.` : 'Too big.';
    case 'not_integer':
      return 'Enter a whole number.';
    case 'invalid_type':
      return 'Enter a valid value.';
    case 'not_an_option':
      return 'Pick one of the options.';
    default:
      return 'Not valid.';
  }
}

// ---- question ----

export function questionDraft(text: string, maxLength = QUESTION_MAX_ANSWER): DraftResult<{ text: string }> {
  const value = text.trim();
  if (!value) return { ok: false, errors: { text: 'Enter an answer.' } };
  if (value.length > maxLength) return { ok: false, errors: { text: `At most ${maxLength} characters.` } };
  return { ok: true, answer: { text: value } };
}

// ---- choice ----

/** The option selected when the card opens: the default option, if any. */
export function initialChoice(props: AskChoiceProps): string | undefined {
  return props.defaultOption;
}

export function choiceDraft(props: AskChoiceProps, selected: string | undefined): DraftResult<{ choice: string }> {
  if (selected === undefined || !props.options.some((o) => o.id === selected)) {
    return { ok: false, errors: { choice: 'Pick one option.' } };
  }
  return { ok: true, answer: { choice: selected } };
}

/** Label of the chosen option (for the answered card), or undefined. */
export function choiceLabel(props: AskChoiceProps, choice: string | undefined): string | undefined {
  return props.options.find((o) => o.id === choice)?.label;
}

// ---- form ----

/** What the form inputs hold: text for every field (select: the option value, '' for none). */
export type FormDraft = Record<string, string>;

export function initialFormDraft(props: AskFormProps): FormDraft {
  return Object.fromEntries(props.fields.map((f) => [f.name, '']));
}

function fieldValue(field: AskFormField, raw: string | undefined): AskFormValue {
  const text = (raw ?? '').trim();
  if (text === '') return null;
  if (field.type === 'number') {
    const n = Number(text);
    return Number.isFinite(n) ? n : text; // a non-number stays text and fails as invalid_type
  }
  return field.type === 'text' ? (raw ?? '').trim() : text;
}

/** Builds `{ values }` from the inputs, with a message per field that does not fit. */
export function formDraft(props: AskFormProps, draft: FormDraft): DraftResult<AskFormAnswer> {
  const values: AskFormAnswer['values'] = {};
  const errors: Record<string, string> = {};
  for (const field of props.fields) {
    const value = fieldValue(field, draft[field.name]);
    values[field.name] = value;
    const issue = formFieldIssues(field, value)[0];
    if (issue) errors[field.name] = issueMessage(issue.slice(issue.lastIndexOf(': ') + 2), field);
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, answer: { values } };
}

/** A stored form value as text (answered card). */
export function formValueText(field: AskFormField, value: AskFormValue | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field.type === 'select') return field.options?.find((o) => o.value === value)?.label ?? String(value);
  return String(value);
}

// ---- confirm ----

export function confirmDraft(props: AskConfirmProps, confirmed: boolean, reason: string): DraftResult<AskConfirmAnswer> {
  const text = reason.trim();
  if (!props.reason) return { ok: true, answer: { confirmed } };
  if (props.reason === 'required' && !text) return { ok: false, errors: { reason: 'Give a reason.' } };
  if (text.length > CONFIRM_REASON_MAX) return { ok: false, errors: { reason: `At most ${CONFIRM_REASON_MAX} characters.` } };
  return { ok: true, answer: text ? { confirmed, reason: text } : { confirmed } };
}
