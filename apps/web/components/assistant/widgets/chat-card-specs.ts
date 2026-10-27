/**
 * WID-3: question, choice, form and confirm cards for the assistant chat (specs, no components).
 *
 * Each card is a suspending frontend tool (WID-1): the model calls it, the run pauses, the Board user
 * answers (or dismisses) the card in the chat, and the answer goes back to the run as the tool result
 * through the AG-UI widget answer path (lib/agui/widgets.ts). These are conversational cards for the
 * run, not Board approvals: nothing here touches approvals or `applyApprovalDecision`.
 *
 * Answers are validated twice with the same code: in the browser (registry.acceptAnswer) and on the
 * server (route → widgetResumeFromEntry, then again in the resumed tool). `checkAnswer` checks the
 * answer against the props the card was asked with (e.g. a choice must be one of the offered
 * options, form values must fit their fields), so a client cannot answer outside the card.
 *
 * Props and answers carry plain text only. Text that looks like it asks for a credential is refused at
 * the props level so a card cannot ask for a password, token, key, card security code or one-time code:
 * form field names and labels, select option labels and choice labels (all terms), and the question,
 * title and placeholders (all terms except bare "secret", "token", "cookie", "pin" and "authorize", common in prose).
 */
import { z } from 'zod';
import type { WidgetSpec } from '@tourbillon/shared/widgets';

// ---------------------------------------------------------------------------------------------
// Credential-like text (cards must not collect secrets).
// ---------------------------------------------------------------------------------------------

/** Cyrillic / Greek letters that look like Latin ones (lower case). */
const CONFUSABLE: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԝ: 'w',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
};

/** Words of a name or text: NFKC, look-alike letters as Latin, split on camelCase, `_` and non-alphanumerics. */
export function credentialWords(value: string): string[] {
  const spaced = value
    .normalize('NFKC')
    .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  const latin = Array.from(spaced, (c) => CONFUSABLE[c] ?? c).join('');
  return latin.split(/[^a-z0-9]+/).filter(Boolean);
}

const CREDENTIAL_WORDS = new Set([
  'password', 'passwords', 'passwd', 'pwd', 'pw', 'passphrase', 'passcode', 'passcodes',
  'credential', 'credentials', 'creds',
  'otp', 'totp', 'hotp', 'mfa', '2fa', 'pincode', 'cvv', 'cvv2', 'cvc', 'cvc2',
  'apikey', 'accesskey', 'secretkey', 'privatekey', 'accesstoken', 'authtoken',
]);
/** Also credential-like in names and labels, but common in prose (questions, titles, placeholders). */
const CREDENTIAL_WORDS_SHORT = new Set([
  'secret', 'secrets', 'token', 'tokens', 'cookie', 'cookies', 'pin', 'pins', 'authorization', 'authorisation',
]);
const CREDENTIAL_PAIRS = new Set([
  'api key', 'access key', 'secret key', 'private key', 'access token', 'auth token', 'bearer token', 'refresh token',
  'auth code', 'mfa code', 'security code', 'verification code', 'login code', 'one time', 'pin code',
  'recovery code', 'recovery codes', 'backup code', 'backup codes', 'seed phrase', 'recovery phrase', 'pass phrase', 'pass code',
]);
/** Stems inside one word (e.g. `userPassword` written `userpassword`). */
const CREDENTIAL_STEMS = /(password|passwd|passphrase|passcode|apikey|privatekey|accesskey|secretkey|accesstoken|credential|pincode)/;
/** Stems refused in names and labels only ("authorize" is common in prose). */
const CREDENTIAL_STEMS_SHORT = /authori[sz]/;

/**
 * Whether a name or text looks like it asks for a credential. `prose` (questions, titles,
 * placeholders) leaves out bare "secret", "token", "cookie", "pin" and "authoriz…". "Passcode" is refused (a secret code);
 * "Passport number", "Compass heading", "Footprint" and "spinCount" are not.
 */
export function isCredentialLike(value: string | undefined, opts: { prose?: boolean } = {}): boolean {
  if (!value) return false;
  const words = credentialWords(value);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (CREDENTIAL_WORDS.has(w) || CREDENTIAL_STEMS.test(w)) return true;
    if (!opts.prose && (CREDENTIAL_WORDS_SHORT.has(w) || CREDENTIAL_STEMS_SHORT.test(w))) return true;
    if (i + 1 < words.length && CREDENTIAL_PAIRS.has(`${w} ${words[i + 1]}`)) return true;
  }
  return false;
}

/** Adds a `credential_text` issue for each credential-like text (`[path, value, prose]`). */
function refuseCredentialText(ctx: z.RefinementCtx, texts: Array<[Array<string | number>, string | undefined, boolean]>) {
  for (const [path, value, prose] of texts) {
    if (isCredentialLike(value, { prose })) ctx.addIssue({ code: 'custom', path, message: 'credential_text' });
  }
}

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

// ---------------------------------------------------------------------------------------------
// askQuestion: one free-text question.
// ---------------------------------------------------------------------------------------------

export const QUESTION_MAX_ANSWER = 4000;

export const askQuestionProps = z
  .strictObject({
    question: text(500).describe('The question to ask the Board user.'),
    detail: optionalText(1000).describe('Optional context shown under the question.'),
    placeholder: optionalText(200),
    multiline: z.boolean().optional().describe('Show a multi-line answer box.'),
    maxLength: z.number().int().min(1).max(QUESTION_MAX_ANSWER).optional().describe('Longest answer in characters (default 4000).'),
  })
  .superRefine((p, ctx) =>
    refuseCredentialText(ctx, [
      [['question'], p.question, true],
      [['placeholder'], p.placeholder, true],
    ]),
  );
export type AskQuestionProps = z.infer<typeof askQuestionProps>;

export const askQuestionAnswer = z.strictObject({ text: text(QUESTION_MAX_ANSWER) });
export type AskQuestionAnswer = z.infer<typeof askQuestionAnswer>;

export const askQuestionSpec: WidgetSpec<AskQuestionProps, AskQuestionAnswer> = {
  name: 'askQuestion',
  version: 1,
  description:
    'Ask the Board user one free-text question in the chat and wait for the typed answer. Use for open questions; ' +
    'use askChoice for a pick from known options, askForm for several fields and askConfirm for yes/no. ' +
    'Never ask for passwords, tokens, keys or other secrets.',
  propsSchema: askQuestionProps,
  answerSchema: askQuestionAnswer,
  frontendTool: true,
  checkAnswer: (props, answer) =>
    answer.text.length > (props.maxLength ?? QUESTION_MAX_ANSWER) ? ['text: too_long'] : [],
};

// ---------------------------------------------------------------------------------------------
// askChoice: single or multi select from labelled options (WID-MS: v2 adds multiSelect).
// ---------------------------------------------------------------------------------------------

const optionId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** WID-MS: `recommended` is one option id, or (when `multiSelect`) a list of option ids. */
const recommendedIds = z.union([optionId, z.array(optionId).min(1).max(10)]);

export const askChoiceProps = z
  .strictObject({
    question: text(500).describe('The question to ask the Board user.'),
    detail: optionalText(1000),
    options: z
      .array(
        z.strictObject({
          id: optionId.describe('Stable id returned as the answer.'),
          label: text(200),
          description: optionalText(300),
        }),
      )
      .min(2)
      .max(10),
    recommended: recommendedIds.optional().describe('Id(s) of the options you recommend (highlighted, not preselected). A list when multiSelect.'),
    defaultOption: optionId.optional().describe('Single-select only: id of the option preselected for the user.'),
    multiSelect: z.boolean().optional().describe('Let the user tick any number of options in this one card (the answer is then the list of chosen ids). For "pick any/all that apply".'),
    minSelected: z.number().int().min(0).optional().describe('multiSelect only: fewest options the user must tick (default 1).'),
    maxSelected: z.number().int().min(1).max(10).optional().describe('multiSelect only: most options the user may tick (default: all options).'),
  })
  .superRefine((p, ctx) => {
    const ids = p.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'duplicate_id' });
    const recommended = p.recommended === undefined ? [] : Array.isArray(p.recommended) ? p.recommended : [p.recommended];
    for (const id of recommended) {
      if (!ids.includes(id)) ctx.addIssue({ code: 'custom', path: ['recommended'], message: 'not_an_option' });
    }
    if (p.defaultOption !== undefined && !ids.includes(p.defaultOption)) {
      ctx.addIssue({ code: 'custom', path: ['defaultOption'], message: 'not_an_option' });
    }
    if (p.multiSelect === true) {
      const max = p.maxSelected ?? ids.length;
      const min = p.minSelected ?? 1;
      if (min > max) ctx.addIssue({ code: 'custom', path: ['minSelected'], message: 'min_above_max' });
      if (max > ids.length) ctx.addIssue({ code: 'custom', path: ['maxSelected'], message: 'max_above_options' });
    }
    refuseCredentialText(ctx, [
      [['question'], p.question, true],
      ...p.options.map((o, i): [Array<string | number>, string, boolean] => [['options', i, 'label'], o.label, false]),
    ]);
  });
export type AskChoiceProps = z.infer<typeof askChoiceProps>;

/** Single-select answers `{ choice }`; multi-select (WID-MS) answers `{ choices }` (unique option ids). */
export const askChoiceAnswer = z.union([
  z.strictObject({ choice: optionId }),
  z.strictObject({ choices: z.array(optionId).max(10) }),
]);
export type AskChoiceAnswer = z.infer<typeof askChoiceAnswer>;

/**
 * WID-MS: checks a choice answer against the card's props. A single-select card takes exactly one
 * offered option; a multi-select card takes a de-duplicated list of offered options, counted against
 * `minSelected`/`maxSelected` (defaults 1 and all options).
 */
export function checkChoiceAnswer(props: AskChoiceProps, answer: AskChoiceAnswer): string[] {
  const ids = props.options.map((o) => o.id);
  if (props.multiSelect === true) {
    if (!('choices' in answer)) return ['choices: invalid_type'];
    const chosen = answer.choices;
    const issues: string[] = [];
    if (new Set(chosen).size !== chosen.length) issues.push('choices: duplicate_id');
    if (chosen.some((id) => !ids.includes(id))) issues.push('choices: not_an_option');
    const min = props.minSelected ?? 1;
    const max = props.maxSelected ?? props.options.length;
    if (chosen.length < min) issues.push('choices: too_few');
    if (chosen.length > max) issues.push('choices: too_many');
    return issues;
  }
  if ('choices' in answer) return ['choices: multi_only'];
  return ids.includes(answer.choice) ? [] : ['choice: not_an_option'];
}

export const askChoiceSpec: WidgetSpec<AskChoiceProps, AskChoiceAnswer> = {
  name: 'askChoice',
  version: 2,
  description:
    'Ask the Board user to pick one or more of 2 to 10 options in the chat and wait for the choice. ' +
    'Single-select answers { choice }; set multiSelect: true for "pick any/all that apply" (answer { choices: [optionId, ...] }, ' +
    'with optional minSelected/maxSelected bounds, minSelected: 0 allows an empty submit). ' +
    'Never emulate multi-select with one single-select card or toggle per option - use multiSelect in one card. ' +
    'Optionally mark options as recommended (highlighted, not preselected).',
  propsSchema: askChoiceProps,
  answerSchema: askChoiceAnswer,
  frontendTool: true,
  checkAnswer: checkChoiceAnswer,
};

/**
 * WID-MS: the v2 rules registered under version 1 as well. Calls that pin `widgetVersion: 1` or omit
 * it (the default version is 1) must still resolve to a card; without this entry they would fall back.
 */
export const askChoiceSpecV1: WidgetSpec<AskChoiceProps, AskChoiceAnswer> = { ...askChoiceSpec, version: 1 };

// ---------------------------------------------------------------------------------------------
// askForm: several fields (text / number / select / multiSelect).
// ---------------------------------------------------------------------------------------------

export const FORM_MAX_FIELDS = 12;
export const FORM_TEXT_MAX = 2000;
export const FORM_MAX_OPTIONS = 20;

const fieldName = z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/);

const formField = z.strictObject({
  name: fieldName.describe('Key of this value in the answer (camelCase).'),
  label: text(200),
  type: z.enum(['text', 'number', 'select', 'multiSelect']),
  required: z.boolean().optional().describe('Default true.'),
  help: optionalText(300),
  placeholder: optionalText(200),
  multiline: z.boolean().optional().describe('text only: multi-line box.'),
  maxLength: z.number().int().min(1).max(FORM_TEXT_MAX).optional().describe('text only (default 2000).'),
  min: z.number().optional().describe('number only.'),
  max: z.number().optional().describe('number only.'),
  integer: z.boolean().optional().describe('number only: whole numbers.'),
  options: z
    .array(z.strictObject({ value: optionId, label: text(200) }))
    .min(1)
    .max(20)
    .optional()
    .describe('select or multiSelect only.'),
  minSelected: z.number().int().min(0).optional().describe('multiSelect only: fewest options the user must tick (default 1).'),
  maxSelected: z.number().int().min(1).max(20).optional().describe('multiSelect only: most options the user may tick (default: all options).'),
});
export type AskFormField = z.infer<typeof formField>;

export const askFormProps = z
  .strictObject({
    title: text(200).describe('What the form is for.'),
    detail: optionalText(1000),
    fields: z.array(formField).min(1).max(FORM_MAX_FIELDS),
    submitLabel: optionalText(40),
  })
  .superRefine((p, ctx) => {
    const names = p.fields.map((f) => f.name);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', path: ['fields'], message: 'duplicate_name' });
    refuseCredentialText(ctx, [[['title'], p.title, true]]);
    p.fields.forEach((f, i) => {
      const at = (key: string) => ['fields', i, key];
      if (isCredentialLike(f.name) || isCredentialLike(f.label)) {
        ctx.addIssue({ code: 'custom', path: at('name'), message: 'credential_field' });
      }
      refuseCredentialText(ctx, [
        [at('placeholder'), f.placeholder, true],
        ...(f.options ?? []).map((o, j): [Array<string | number>, string, boolean] => [['fields', i, 'options', j, 'label'], o.label, false]),
      ]);
      if (f.type === 'select' || f.type === 'multiSelect') {
        if (!f.options) ctx.addIssue({ code: 'custom', path: at('options'), message: 'required_for_select' });
        else if (new Set(f.options.map((o) => o.value)).size !== f.options.length) {
          ctx.addIssue({ code: 'custom', path: at('options'), message: 'duplicate_value' });
        }
      } else if (f.options) ctx.addIssue({ code: 'custom', path: at('options'), message: 'select_only' });
      if (f.type !== 'number' && (f.min !== undefined || f.max !== undefined || f.integer !== undefined)) {
        ctx.addIssue({ code: 'custom', path: at('type'), message: 'number_only' });
      }
      if (f.type !== 'text' && (f.maxLength !== undefined || f.multiline !== undefined)) {
        ctx.addIssue({ code: 'custom', path: at('type'), message: 'text_only' });
      }
      if (f.type !== 'multiSelect' && (f.minSelected !== undefined || f.maxSelected !== undefined)) {
        ctx.addIssue({ code: 'custom', path: at('type'), message: 'multi_select_only' });
      }
      if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
        ctx.addIssue({ code: 'custom', path: at('min'), message: 'min_above_max' });
      }
      if (f.type === 'multiSelect' && f.options) {
        const maxTicks = f.maxSelected ?? f.options.length;
        if (f.minSelected !== undefined && f.minSelected > maxTicks) {
          ctx.addIssue({ code: 'custom', path: at('minSelected'), message: 'min_above_max' });
        }
        if (f.options.length > 0 && maxTicks > f.options.length) {
          ctx.addIssue({ code: 'custom', path: at('maxSelected'), message: 'max_above_options' });
        }
      }
    });
  });
export type AskFormProps = z.infer<typeof askFormProps>;

/** WID-MS: a multiSelect field's value is a `string[]` of option values (unique, and all offered). */
export const askFormAnswer = z.strictObject({
  values: z.record(fieldName, z.union([z.string().max(FORM_TEXT_MAX), z.number(), z.array(optionId).max(FORM_MAX_OPTIONS), z.null()])),
});
export type AskFormAnswer = z.infer<typeof askFormAnswer>;
export type AskFormValue = AskFormAnswer['values'][string];

/** Problems with one form value against its field (`fields.<name>: code`, never the value). */
export function formFieldIssues(field: AskFormField, value: AskFormValue | undefined): string[] {
  const at = `values.${field.name}`;
  const required = field.required !== false;
  const empty =
    value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);
  if (empty) return required ? [`${at}: required`] : [];
  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') return [`${at}: invalid_type`];
      return value.length > (field.maxLength ?? FORM_TEXT_MAX) ? [`${at}: too_long`] : [];
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${at}: invalid_type`];
      if (field.integer && !Number.isInteger(value)) return [`${at}: not_integer`];
      if (field.min !== undefined && value < field.min) return [`${at}: too_small`];
      if (field.max !== undefined && value > field.max) return [`${at}: too_big`];
      return [];
    }
    case 'select':
      if (typeof value !== 'string') return [`${at}: invalid_type`];
      return field.options?.some((o) => o.value === value) ? [] : [`${at}: not_an_option`];
    case 'multiSelect': {
      if (!Array.isArray(value)) return [`${at}: invalid_type`];
      const offered = field.options?.map((o) => o.value) ?? [];
      if (new Set(value).size !== value.length) return [`${at}: duplicate_value`];
      if (value.some((v) => !offered.includes(v))) return [`${at}: not_an_option`];
      const min = field.minSelected ?? 1;
      const max = field.maxSelected ?? offered.length;
      if (value.length < min) return [`${at}: too_few`];
      if (value.length > max) return [`${at}: too_many`];
      return [];
    }
  }
}

export function checkFormAnswer(props: AskFormProps, answer: AskFormAnswer): string[] {
  const issues: string[] = [];
  const known = new Set(props.fields.map((f) => f.name));
  for (const key of Object.keys(answer.values)) if (!known.has(key)) issues.push(`values.${key}: unknown_field`);
  for (const field of props.fields) issues.push(...formFieldIssues(field, answer.values[field.name]));
  return issues;
}

export const askFormSpec: WidgetSpec<AskFormProps, AskFormAnswer> = {
  name: 'askForm',
  version: 1,
  description:
    'Ask the Board user to fill in a short form (1 to 12 fields: text, number, select or multiSelect) in the chat and wait for ' +
    'the values. The answer is { values: { <field name>: value } }; an empty optional field is null, and a multiSelect field ' +
    'answers with a string[] of option values (use multiSelect for "pick any/all that apply" - never a toggle or single-select per option). ' +
    'Never ask for passwords, tokens, keys or other secrets.',
  propsSchema: askFormProps,
  answerSchema: askFormAnswer,
  frontendTool: true,
  checkAnswer: checkFormAnswer,
};

// ---------------------------------------------------------------------------------------------
// askConfirm: confirm / cancel with an optional reason.
// ---------------------------------------------------------------------------------------------

export const CONFIRM_REASON_MAX = 1000;

export const askConfirmProps = z.strictObject({
  question: text(500).describe('What the Board user is asked to confirm.'),
  detail: optionalText(1000),
  confirmLabel: optionalText(40).describe('Default "Confirm".'),
  cancelLabel: optionalText(40).describe('Default "Cancel".'),
  reason: z
    .enum(['optional', 'required'])
    .optional()
    .describe('Ask for a reason with the answer: optional, or required. Omit for no reason box.'),
  destructive: z.boolean().optional().describe('Style the confirm button as a destructive action.'),
});
export type AskConfirmProps = z.infer<typeof askConfirmProps>;

export const askConfirmAnswer = z.strictObject({
  confirmed: z.boolean(),
  reason: z.string().trim().max(CONFIRM_REASON_MAX).optional(),
});
export type AskConfirmAnswer = z.infer<typeof askConfirmAnswer>;

export const askConfirmSpec: WidgetSpec<AskConfirmProps, AskConfirmAnswer> = {
  name: 'askConfirm',
  version: 1,
  description:
    'Ask the Board user to confirm or cancel something in the chat and wait for the answer ({ confirmed, reason? }). ' +
    'Set reason to "optional" or "required" to ask for a reason with the answer.',
  propsSchema: askConfirmProps,
  answerSchema: askConfirmAnswer,
  frontendTool: true,
  checkAnswer: (props, answer) => {
    const given = answer.reason !== undefined && answer.reason !== '';
    if (!props.reason) return given ? ['reason: not_asked'] : [];
    if (props.reason === 'required' && !given) return ['reason: required'];
    return [];
  },
};

/** The WID-3 chat cards, in registry order. WID-MS: askChoice is registered at v1 and v2 (identical rules; v2 is what the model is offered). */
export const chatCardSpecs = [askQuestionSpec, askChoiceSpecV1, askChoiceSpec, askFormSpec, askConfirmSpec] as const;
