/**
 * WID-3: pure helpers behind the chat cards (chat-cards.tsx): turn what the user typed or picked into
 * an answer, or say what is missing. The answer is then validated again by the registry and the
 * server with the spec's own checks (chat-card-specs.ts); these helpers only drive the card's UI.
 *
 * WID-MS: multi-select drafts. A multi-select choice card and a multiSelect form field both hold a
 * `string[]` in the draft; answers carry `{ choices }` / a `string[]` value, so thread-history
 * replay and parked widgets round-trip the array unchanged.
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

/** Field bounds used by `issueMessage` (undefined falls back to the generic message). */
type FieldBounds = Pick<AskFormField, 'min' | 'max' | 'maxLength'> & { minSelected?: number; maxSelected?: number };

/** Message for an issue code (from formFieldIssues and the card checks); never echoes values. */
export function issueMessage(code: string, field?: FieldBounds): string {
  switch (code) {
    case 'required':
      return 'Required.';
    case 'too_long':
      return field?.maxLength ? `At most ${field.maxLength} characters.` : 'Too long.';
    case 'too_small':
      return field?.min !== undefined ? `At least ${field.min}.` : 'Too small.';
    case 'too_big':
      return field?.max !== undefined ? `At most ${field.max}.` : 'Too big.';
    case 'too_few':
      return field?.minSelected !== undefined ? `Choose at least ${field.minSelected} options.` : 'Choose more options.';
    case 'too_many':
      return field?.maxSelected !== undefined ? `Choose at most ${field.maxSelected} options.` : 'Choose fewer options.';
    case 'not_integer':
      return 'Enter a whole number.';
    case 'invalid_type':
      return 'Enter a valid value.';
    case 'not_an_option':
      return 'Pick one of the options.';
    case 'duplicate_id':
    case 'duplicate_value':
      return 'These options have already been picked.';
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

/** The option selected when the card opens: the default option, if any (single-select only). */
export function initialChoice(props: AskChoiceProps): string | undefined {
  return props.defaultOption;
}

/** What the choice card holds: one option id (single) or the ticked ids (multi-select). */
export type ChoiceDraft = string | string[] | undefined;

/** The option ids ticked when the multi-select card opens (none: `recommended` is a hint, not a preselection). */
export function initialChoiceDraft(props: AskChoiceProps): ChoiceDraft {
  return props.multiSelect === true ? [] : props.defaultOption;
}

/** Bounds a multi-select card enforces in its UI (same defaults as `checkChoiceAnswer`). */
export function choiceBounds(props: AskChoiceProps): { min: number; max: number } {
  return { min: props.minSelected ?? 1, max: props.maxSelected ?? props.options.length };
}

/**
 * Builds `{ choice }` or (WID-MS) `{ choices }` from the card's selection. Multi-select also checks
 * count bounds, de-duplication and membership, so the UI refuses what the server would refuse.
 */
export function choiceDraft(props: AskChoiceProps, selected: ChoiceDraft): DraftResult<{ choice: string } | { choices: string[] }> {
  const ids = props.options.map((o) => o.id);
  if (props.multiSelect === true) {
    const chosen = Array.isArray(selected) ? Array.from(new Set(selected)) : selected === undefined ? [] : [selected];
    const { min, max } = choiceBounds(props);
    if (chosen.length < min) return { ok: false, errors: { choices: `Choose at least ${min} option${min === 1 ? '' : 's'}.` } };
    if (chosen.length > max) return { ok: false, errors: { choices: `Choose at most ${max} options.` } };
    if (chosen.some((id) => !ids.includes(id))) return { ok: false, errors: { choices: 'Pick options from the list.' } };
    return { ok: true, answer: { choices: chosen } };
  }
  const single = Array.isArray(selected) ? selected[0] : selected;
  if (single === undefined || !ids.includes(single)) return { ok: false, errors: { choice: 'Pick one option.' } };
  return { ok: true, answer: { choice: single } };
}

/** Label of the chosen option (for the answered card), or undefined. */
export function choiceLabel(props: AskChoiceProps, choice: string | undefined): string | undefined {
  return props.options.find((o) => o.id === choice)?.label;
}

/** Labels of the chosen options (answered multi-select card); ids stand in for unknown ones. */
export function choiceLabels(props: AskChoiceProps, choices: string[] | undefined): string {
  return (choices ?? []).map((id) => props.options.find((o) => o.id === id)?.label ?? id).join(', ');
}

// ---- form ----

/** What the form inputs hold: text for every field (select: the option value, '' for none; multiSelect: the ticked values). */
export type FormDraft = Record<string, string | string[]>;

export function initialFormDraft(props: AskFormProps): FormDraft {
  return Object.fromEntries(props.fields.map((f) => [f.name, f.type === 'multiSelect' ? [] : '']));
}

function fieldValue(field: AskFormField, raw: string | string[] | undefined): AskFormValue {
  if (Array.isArray(raw)) {
    const chosen = Array.from(new Set(raw));
    return chosen.length === 0 ? null : chosen;
  }
  const text = (raw ?? '').trim();
  if (text === '') return null;
  if (field.type === 'number') {
    const n = Number(text);
    return Number.isFinite(n) ? n : text; // a non-number stays text and fails as invalid_type
  }
  return text;
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
  if (field.type === 'multiSelect' && Array.isArray(value)) {
    const labels = value.map((v) => field.options?.find((o) => o.value === v)?.label ?? v);
    return labels.length > 0 ? labels.join(', ') : '—';
  }
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
