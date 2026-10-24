/**
 * APR-2: hitl v0 message shapes (`hitl/request/v0`, `hitl/response/v0`, `hitl/event/v0`) as zod
 * schemas, shared by every Tourbillon entry point (REST create, agent tool, board decide, MCP
 * decide, HITLy resume, expiry sweep).
 *
 * Source: https://github.com/hitly-net/hitl-spec (SPEC.md and schemas/v0 at c0cf379), plus the
 * 24 Oct rulings. Rules the JSON Schemas cannot express (option values unique, defaults valid for
 * the request, refs unique, bounds consistent, I-Regexp patterns) are checked here too.
 *
 * - Every object is strict: an unknown key is refused with a field error naming it. Extensions go
 *   only in `_meta`, under reverse-DNS keys (`net.hitly/...`); receivers ignore `_meta` keys they
 *   do not understand.
 * - Errors are per field, as JSON Pointers with a fix hint (`hitlFieldErrors`).
 * - Answers are validated, never altered (`validateHitlAnswer` does not trim or coerce).
 */
import { z } from 'zod';
import { compileIRegexp } from './iregexp';

export const HITL_REQUEST_SPEC = 'hitl/request/v0';
export const HITL_RESPONSE_SPEC = 'hitl/response/v0';
export const HITL_EVENT_SPEC = 'hitl/event/v0';

export const HITL_ANSWER_TYPES = ['binary', 'single', 'multi', 'number', 'text', 'secret'] as const;
export type HitlAnswerType = (typeof HITL_ANSWER_TYPES)[number];
export const HITL_RESPONSE_STATUSES = ['answered', 'declined', 'cancelled', 'expired'] as const;
export type HitlResponseStatus = (typeof HITL_RESPONSE_STATUSES)[number];
export const HITL_BINARY_VALUES = ['approve', 'reject'] as const;
export const HITL_ACTOR_KINDS = ['human', 'group', 'service'] as const;
export const HITL_EVENT_TYPES = ['presented', 'opened', 'decided', 'bytes', 'scroll'] as const;
export type HitlEventType = (typeof HITL_EVENT_TYPES)[number];
export const HITL_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;

/** Reverse-DNS `_meta` key, e.g. `net.hitly/trace`. */
export const HITL_META_KEY = /^[a-z0-9-]+(\.[a-z0-9-]+)+\/[A-Za-z0-9._/-]+$/;
const SHA256_B64URL = /^[A-Za-z0-9_-]{43}$/;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Inline attachments: about 256 KB of content at most (base64 length). */
export const HITL_INLINE_MAX = 349_528;

const hint = (h: string) => ({ params: { hint: h } });

const identifier = z.string().min(1).max(200);
const sha256 = z.string().regex(SHA256_B64URL, { message: 'must be an unpadded base64url SHA-256 (43 characters)' });
const dateTime = z.iso.datetime({ offset: true, message: 'must be an RFC 3339 date-time, e.g. 2026-10-26T17:00:00Z' });
const httpsUrl = z.string().refine(
  (v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && !!u.hostname;
    } catch {
      return false;
    }
  },
  { message: 'must be an absolute https:// URL', ...hint('Use https; http and other schemes are refused.') },
);

export const hitlMetaSchema = z.record(
  z.string().regex(HITL_META_KEY, {
    message: '_meta keys must be reverse-DNS, e.g. "net.hitly/trace"',
  }),
  z.unknown(),
);

const ref = z
  .string()
  .min(1)
  .max(100)
  .refine((v) => v !== 'context', { message: '"context" is reserved for the context markdown', ...hint('Pick another ref.') });

const option = z.strictObject({
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});

const link = z.strictObject({
  ref,
  url: httpsUrl,
  label: z.string().min(1),
  description: z.string().optional(),
  mustOpen: z.boolean().optional(),
});

const attachment = z
  .strictObject({
    ref,
    name: z.string().min(1),
    mediaType: z.string().regex(MEDIA_TYPE, { message: 'must be a media type such as application/pdf' }),
    size: z.number().int().min(0),
    sha256,
    url: httpsUrl.optional(),
    inline: z
      .string()
      .max(HITL_INLINE_MAX, { message: 'inline content is limited to about 256 KB' })
      .regex(BASE64, { message: 'inline must be base64' })
      .optional(),
    mustOpen: z.boolean().optional(),
  })
  .superRefine((a, ctx) => {
    if ((a.url === undefined) === (a.inline === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: a.url === undefined ? [] : ['inline'],
        message: 'exactly one of url or inline is required',
        ...hint('Give an https url, or inline base64 for a small file, not both.'),
      });
    }
  });

const context = z.strictObject({
  markdown: z.string().optional(),
  links: z.array(link).optional(),
  attachments: z.array(attachment).optional(),
});

export const hitlNumberBoundsSchema = z.strictObject({
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().gt(0, { message: 'step must be greater than zero' }).optional(),
  unit: z.string().min(1).optional(),
});
export const hitlMultiBoundsSchema = z.strictObject({
  minItems: z.number().int().min(0).optional(),
  maxItems: z.number().int().min(1).optional(),
});
export const hitlTextBoundsSchema = z.strictObject({
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(1).optional(),
  pattern: z.string().max(256, { message: 'pattern is limited to 256 characters' }).optional(),
});
export type HitlNumberBounds = z.infer<typeof hitlNumberBoundsSchema>;
export type HitlMultiBounds = z.infer<typeof hitlMultiBoundsSchema>;
export type HitlTextBounds = z.infer<typeof hitlTextBoundsSchema>;

const actorKind = z.enum(HITL_ACTOR_KINDS);
export const hitlDecidedBySchema = z.strictObject({
  kind: actorKind,
  id: z.string().min(1),
  display: z.string().min(1).optional(),
});
export type HitlDecidedBy = z.infer<typeof hitlDecidedBySchema>;

/** Fields of a request, without the cross-field rules (used for agent tool input too). */
export const hitlRequestFields = {
  spec: z.literal(HITL_REQUEST_SPEC),
  id: identifier.optional(),
  idempotencyKey: identifier.optional(),
  question: z
    .string()
    .min(2)
    .max(160, { message: 'question is limited to 160 characters' })
    .regex(/\?$/, { message: 'question must end with "?"' }),
  answerType: z.enum(HITL_ANSWER_TYPES),
  options: z.array(option).min(1).optional(),
  bounds: z.unknown().optional(),
  default: z.unknown().optional(),
  recommended: z.strictObject({ value: z.unknown(), reason: z.string().min(1) }).optional(),
  reasonRequired: z.array(z.union([z.string(), z.number()])).optional(),
  deadline: dateTime.optional(),
  onExpiry: z.literal('expire', { message: 'onExpiry must be absent or "expire" in v0' }).optional(),
  context: context.optional(),
  action: z.strictObject({ name: z.string().min(1), argsHash: sha256 }).optional(),
  risk: z
    .strictObject({ level: z.enum(HITL_RISK_LEVELS).optional(), reversible: z.boolean().optional() })
    .optional(),
  requester: z.strictObject({
    agentId: z.string().min(1),
    runId: z.string().min(1).optional(),
    onBehalfOf: z.string().min(1).optional(),
  }),
  encryption: z
    .strictObject({
      publicKey: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/, { message: 'publicKey must be base64url' }),
      alg: z.string().min(1),
    })
    .optional(),
  _meta: hitlMetaSchema.optional(),
};

type Ctx = z.RefinementCtx;
type Path = Array<string | number>;
const issue = (ctx: Ctx, path: Path, message: string, h?: string) =>
  ctx.addIssue({ code: 'custom', path, message, ...(h ? hint(h) : {}) });

function forbid(ctx: Ctx, obj: Record<string, unknown>, keys: string[], answerType: string) {
  for (const k of keys) {
    if (obj[k] !== undefined) issue(ctx, [k], `${k} is not allowed for answerType "${answerType}"`, `Remove ${k}.`);
  }
}

/** Parse a sub-value with a schema and copy its issues to the parent at `path`. */
function sub<T>(ctx: Ctx, schema: z.ZodType<T>, value: unknown, path: Path): T | undefined {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  for (const i of r.error.issues) {
    ctx.addIssue({ ...(i as unknown as z.core.$ZodRawIssue), path: [...path, ...i.path] } as never);
  }
  return undefined;
}

type RequestShape = z.infer<z.ZodObject<typeof hitlRequestFields>>;

/** Why `value` is not a valid answer for the request, or null when it is. Never alters `value`. */
export function hitlValueProblem(req: RequestShape, value: unknown): string | null {
  const optionValues = (req.options ?? []).map((o) => o.value);
  switch (req.answerType) {
    case 'binary':
      return value === 'approve' || value === 'reject' ? null : 'must be "approve" or "reject"';
    case 'single':
      if (typeof value !== 'string') return 'must be one option value (string)';
      return optionValues.includes(value) ? null : `must be one of: ${optionValues.join(', ')}`;
    case 'multi': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return 'must be an array of option values';
      if (new Set(value).size !== value.length) return 'values must be distinct';
      const bad = value.find((v) => !optionValues.includes(v as string));
      if (bad !== undefined) return `"${bad}" is not an option value`;
      const b = hitlMultiBoundsSchema.safeParse(req.bounds ?? {});
      const bounds = b.success ? b.data : {};
      if (bounds.minItems !== undefined && value.length < bounds.minItems) return `pick at least ${bounds.minItems}`;
      if (bounds.maxItems !== undefined && value.length > bounds.maxItems) return `pick at most ${bounds.maxItems}`;
      return null;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
      const b = hitlNumberBoundsSchema.safeParse(req.bounds ?? {});
      const bounds = b.success ? b.data : {};
      if (bounds.min !== undefined && value < bounds.min) return `must be at least ${bounds.min}`;
      if (bounds.max !== undefined && value > bounds.max) return `must be at most ${bounds.max}`;
      if (bounds.step !== undefined) {
        const q = (value - (bounds.min ?? 0)) / bounds.step;
        if (Math.abs(q - Math.round(q)) > 1e-9) return `must be a multiple of ${bounds.step} from ${bounds.min ?? 0}`;
      }
      return null;
    }
    case 'text': {
      if (typeof value !== 'string') return 'must be a string';
      const b = hitlTextBoundsSchema.safeParse(req.bounds ?? {});
      const bounds = b.success ? b.data : {};
      const len = Array.from(value).length;
      if (bounds.minLength !== undefined && len < bounds.minLength) return `must be at least ${bounds.minLength} characters`;
      if (bounds.maxLength !== undefined && len > bounds.maxLength) return `must be at most ${bounds.maxLength} characters`;
      if (bounds.pattern !== undefined) {
        const re = compileIRegexp(bounds.pattern);
        if (re.ok && !re.test(value)) return 'does not match the required pattern';
      }
      return null;
    }
    case 'secret':
      return typeof value === 'string' && value.length > 0 ? null : 'must be the ciphertext string';
  }
}

function checkRequestRules(req: RequestShape, ctx: Ctx): void {
  const obj = req as unknown as Record<string, unknown>;
  const t = req.answerType;
  const hasOptions = t === 'binary' || t === 'single' || t === 'multi';

  if (hasOptions) {
    if (!req.options) issue(ctx, ['options'], `options are required for answerType "${t}"`, 'Add options [{value, label}].');
    const values = (req.options ?? []).map((o) => o.value);
    values.forEach((v, i) => {
      if (values.indexOf(v) !== i) issue(ctx, ['options', i, 'value'], `duplicate option value "${v}"`, 'Option values must be unique.');
    });
    if (t === 'binary' && req.options) {
      const ok = values.length === 2 && values.includes('approve') && values.includes('reject');
      if (!ok) {
        issue(ctx, ['options'], 'binary needs exactly two options with values "approve" and "reject"', 'Keep the values fixed; labels are free text.');
      }
    }
  } else {
    forbid(ctx, obj, ['options'], t);
  }
  if (t === 'secret') {
    if (!req.encryption) issue(ctx, ['encryption'], 'encryption {publicKey, alg} is required for secret', 'Add the requester public key.');
    forbid(ctx, obj, ['bounds', 'default', 'recommended', 'reasonRequired'], t);
  } else {
    forbid(ctx, obj, ['encryption'], t);
  }
  if (t === 'binary' || t === 'single') forbid(ctx, obj, ['bounds'], t);

  // Bounds per type, and their consistency.
  if (req.bounds !== undefined) {
    if (t === 'multi') {
      const b = sub(ctx, hitlMultiBoundsSchema, req.bounds, ['bounds']);
      if (b?.minItems !== undefined && b.maxItems !== undefined && b.minItems > b.maxItems) {
        issue(ctx, ['bounds', 'minItems'], 'minItems is greater than maxItems');
      }
      if (b?.minItems !== undefined && req.options && b.minItems > req.options.length) {
        issue(ctx, ['bounds', 'minItems'], 'minItems is greater than the number of options');
      }
    } else if (t === 'number') {
      const b = sub(ctx, hitlNumberBoundsSchema, req.bounds, ['bounds']);
      if (b?.min !== undefined && b.max !== undefined && b.min > b.max) issue(ctx, ['bounds', 'min'], 'min is greater than max');
    } else if (t === 'text') {
      const b = sub(ctx, hitlTextBoundsSchema, req.bounds, ['bounds']);
      if (b?.minLength !== undefined && b.maxLength !== undefined && b.minLength > b.maxLength) {
        issue(ctx, ['bounds', 'minLength'], 'minLength is greater than maxLength');
      }
      if (b?.pattern !== undefined) {
        const re = compileIRegexp(b.pattern);
        if (!re.ok) {
          issue(ctx, ['bounds', 'pattern'], `not an RFC 9485 I-Regexp: ${re.error} (at ${re.index})`, 'Use the I-Regexp subset; the whole value is matched, so no ^ or $ anchors are needed.');
        }
      }
    }
  }

  // default / recommended / reasonRequired must be valid answers.
  if (t !== 'secret') {
    if (req.default !== undefined) {
      const p = hitlValueProblem(req, req.default);
      if (p) issue(ctx, ['default'], `default ${p}`);
    }
    if (req.recommended) {
      const p = hitlValueProblem(req, req.recommended.value);
      if (p) issue(ctx, ['recommended', 'value'], `recommended value ${p}`);
    }
    const rr = req.reasonRequired ?? [];
    rr.forEach((v, i) => {
      if (rr.indexOf(v) !== i) issue(ctx, ['reasonRequired', i], 'reasonRequired values must be unique');
      // Option types list option values; number and text list exact answers.
      const p =
        t === 'multi' || t === 'single'
          ? typeof v === 'string' && (req.options ?? []).some((o) => o.value === v)
            ? null
            : 'must be an option value'
          : hitlValueProblem(req, v);
      if (p) issue(ctx, ['reasonRequired', i], `reasonRequired entry ${p}`);
    });
  }

  // refs unique across links and attachments.
  const seen = new Map<string, string>();
  const refs: Array<[Path, string]> = [
    ...(req.context?.links ?? []).map((l, i) => [['context', 'links', i, 'ref'], l.ref] as [Path, string]),
    ...(req.context?.attachments ?? []).map((a, i) => [['context', 'attachments', i, 'ref'], a.ref] as [Path, string]),
  ];
  for (const [path, r] of refs) {
    if (seen.has(r)) issue(ctx, path, `duplicate ref "${r}"`, 'Refs must be unique across links and attachments.');
    seen.set(r, r);
  }
}

export const hitlRequestSchema = z.strictObject(hitlRequestFields).superRefine(checkRequestRules);
export type HitlRequest = z.infer<typeof hitlRequestSchema>;

const answerValue = z.union([z.string(), z.number(), z.array(z.string())]);
export type HitlValue = z.infer<typeof answerValue>;

const signature = z.union([
  z.strictObject({
    alg: z.literal('Ed25519'),
    kid: z.string().min(1),
    sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/, { message: 'sig must be an 86-character b64url Ed25519 signature' }),
  }),
  z.null(),
]);

export const hitlEventSchema = z
  .strictObject({
    spec: z.literal(HITL_EVENT_SPEC),
    id: identifier,
    requestId: identifier,
    type: z.enum(HITL_EVENT_TYPES),
    itemRef: z.string().min(1).max(100).optional(),
    at: dateTime,
    actor: z.strictObject({ kind: actorKind, id: z.string().min(1) }),
    source: z.enum(['host', 'client']),
    data: z.record(z.string(), z.unknown()).optional(),
    prevHash: z.union([sha256, z.null()]),
    hash: sha256,
    _meta: hitlMetaSchema.optional(),
  })
  .superRefine((e, ctx) => {
    if (e.type === 'presented' || e.type === 'decided') {
      if (e.source !== 'host') issue(ctx, ['source'], `${e.type} events have source "host"`);
      if (e.data !== undefined) issue(ctx, ['data'], `${e.type} events carry no data`);
    }
    if (e.type !== 'presented' && e.type !== 'decided' && e.itemRef === undefined) {
      issue(ctx, ['itemRef'], `itemRef is required for ${e.type} events`);
    }
    if (e.type === 'opened' && e.data !== undefined) issue(ctx, ['data'], 'opened events carry no data');
    if (e.type === 'bytes') {
      if (e.itemRef === 'context') issue(ctx, ['itemRef'], 'bytes events cannot use "context"');
      if (e.source !== 'host') issue(ctx, ['source'], 'bytes events have source "host"');
      sub(
        ctx,
        z.strictObject({ bytesServed: z.number().int().min(0), bytesTotal: z.number().int().min(0) }),
        e.data,
        ['data'],
      );
    }
    if (e.type === 'scroll') {
      if (e.source !== 'client') issue(ctx, ['source'], 'scroll events have source "client"');
      sub(ctx, z.strictObject({ maxFraction: z.number().min(0).max(1), reachedEnd: z.boolean() }), e.data, ['data']);
    }
  });
export type HitlEvent = z.infer<typeof hitlEventSchema>;

export const hitlResponseSchema = z
  .strictObject({
    spec: z.literal(HITL_RESPONSE_SPEC),
    requestId: identifier,
    status: z.enum(HITL_RESPONSE_STATUSES),
    value: answerValue.optional(),
    reason: z.string().min(1).optional(),
    decidedBy: hitlDecidedBySchema.optional(),
    decidedAt: dateTime.optional(),
    argsHash: sha256.optional(),
    signature: signature.optional(),
    activity: z.strictObject({
      presentedAt: z.union([dateTime, z.null()]),
      items: z.array(
        z.strictObject({
          ref: z.string().min(1),
          sha256: z.union([sha256, z.null()]),
          openedAt: z.array(dateTime),
        }),
      ),
      events: z.array(hitlEventSchema).optional(),
    }),
    _meta: hitlMetaSchema.optional(),
  })
  .superRefine((r, ctx) => {
    if (Array.isArray(r.value) && new Set(r.value).size !== r.value.length) issue(ctx, ['value'], 'values must be distinct');
    if (r.status === 'answered') {
      for (const k of ['value', 'decidedBy', 'decidedAt'] as const) {
        if (r[k] === undefined) issue(ctx, [k], `${k} is required when status is "answered"`);
      }
    }
    if (r.status === 'declined') {
      for (const k of ['decidedBy', 'decidedAt'] as const) {
        if (r[k] === undefined) issue(ctx, [k], `${k} is required when status is "declined"`);
      }
    }
    if (r.status !== 'answered' && r.value !== undefined) {
      issue(ctx, ['value'], `value must be absent when status is "${r.status}"`);
    }
    if (r.status === 'expired') {
      for (const k of ['decidedBy', 'decidedAt'] as const) {
        if (r[k] !== undefined) issue(ctx, [k], `${k} must be absent when status is "expired"`);
      }
    }
  });
export type HitlResponse = z.infer<typeof hitlResponseSchema>;

// ---- field errors -------------------------------------------------------------------------------

export interface HitlFieldError {
  /** JSON Pointer to the failing field ('' is the whole message). */
  field: string;
  message: string;
  hint?: string;
}

export function jsonPointer(path: ReadonlyArray<PropertyKey>): string {
  return path.map((p) => `/${String(p).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

const UNKNOWN_KEY_HINT = 'Remove it. Extensions go only in _meta, under a reverse-DNS key such as "com.example/key".';

/** Per-field errors (JSON Pointer + hint) for a zod error from one of the hitl schemas. */
export function hitlFieldErrors(error: z.ZodError): HitlFieldError[] {
  const out: HitlFieldError[] = [];
  for (const i of error.issues) {
    if (i.code === 'unrecognized_keys') {
      for (const key of i.keys) {
        out.push({ field: jsonPointer([...i.path, key]), message: `unknown key "${key}"`, hint: UNKNOWN_KEY_HINT });
      }
      continue;
    }
    const h = (i as { params?: { hint?: unknown } }).params?.hint;
    out.push({ field: jsonPointer(i.path), message: i.message, ...(typeof h === 'string' ? { hint: h } : {}) });
  }
  return out;
}

export type HitlParseResult<T> = { ok: true; value: T } | { ok: false; errors: HitlFieldError[] };

function parseWith<T>(schema: z.ZodType<T>, input: unknown): HitlParseResult<T> {
  const r = schema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, errors: hitlFieldErrors(r.error) };
}

export const parseHitlRequest = (input: unknown) => parseWith(hitlRequestSchema, input);
export const parseHitlResponse = (input: unknown) => parseWith(hitlResponseSchema, input);
export const parseHitlEvent = (input: unknown) => parseWith(hitlEventSchema, input);

/**
 * Validate a request submitted by an agent. On top of the schema: an agent-sent `id` is refused
 * (the host assigns it) and `requester.agentId` must be the calling agent.
 */
export function parseHitlRequestForIngest(
  input: unknown,
  caller: { agentId: string },
): HitlParseResult<HitlRequest> {
  const errors: HitlFieldError[] = [];
  if (input && typeof input === 'object' && 'id' in input) {
    errors.push({ field: '/id', message: 'id is assigned by the host', hint: 'Remove id; use idempotencyKey for your own handle.' });
  }
  const parsed = parseHitlRequest(input);
  if (!parsed.ok) errors.push(...parsed.errors.filter((e) => e.field !== '/id'));
  else if (parsed.value.requester.agentId !== caller.agentId) {
    errors.push({ field: '/requester/agentId', message: 'requester.agentId must be the calling agent', hint: `Use "${caller.agentId}".` });
  }
  return errors.length || !parsed.ok ? { ok: false, errors } : parsed;
}

/** Answer values that need a reason. Binary defaults to ["reject"]. */
export function effectiveReasonRequired(req: HitlRequest): Array<string | number> {
  if (req.answerType === 'secret') return [];
  if (req.reasonRequired) return req.reasonRequired;
  return req.answerType === 'binary' ? ['reject'] : [];
}

/** Does this answer trigger reasonRequired? */
export function hitlReasonRequiredFor(req: HitlRequest, value: unknown): boolean {
  const rr = effectiveReasonRequired(req);
  if (rr.length === 0) return false;
  if (req.answerType === 'multi') return Array.isArray(value) && value.some((v) => rr.includes(v));
  return rr.some((r) => r === value);
}

/** Items the reviewer must open before answering. */
export function hitlMustOpenRefs(req: HitlRequest): string[] {
  return [...(req.context?.links ?? []), ...(req.context?.attachments ?? [])].filter((i) => i.mustOpen).map((i) => i.ref);
}

export interface HitlAnswerSubmission {
  status: 'answered' | 'declined';
  value?: unknown;
  reason?: string;
}

/**
 * Host-side check of a submitted answer against the request rules (type, options, bounds, pattern,
 * required reason, mustOpen). Returns field errors; an empty list means valid. The value is never
 * changed.
 */
export function validateHitlAnswer(
  req: HitlRequest,
  submission: HitlAnswerSubmission,
  opts: { openedRefs?: ReadonlySet<string> } = {},
): HitlFieldError[] {
  const errors: HitlFieldError[] = [];
  if (submission.reason !== undefined && (typeof submission.reason !== 'string' || submission.reason.length === 0)) {
    errors.push({ field: '/reason', message: 'reason must be a non-empty string' });
  }
  if (submission.status === 'declined') {
    if (submission.value !== undefined) errors.push({ field: '/value', message: 'value must be absent when declining' });
    return errors;
  }
  if (submission.status !== 'answered') {
    errors.push({ field: '/status', message: 'status must be "answered" or "declined"' });
    return errors;
  }
  if (submission.value === undefined) {
    errors.push({ field: '/value', message: 'value is required' });
  } else {
    const p = hitlValueProblem(req, submission.value);
    if (p) errors.push({ field: '/value', message: `value ${p}` });
  }
  if (hitlReasonRequiredFor(req, submission.value) && !(typeof submission.reason === 'string' && submission.reason.trim().length > 0)) {
    errors.push({ field: '/reason', message: 'a reason is required for this answer', hint: 'Say why.' });
  }
  const opened = opts.openedRefs ?? new Set<string>();
  const items = [
    ...(req.context?.links ?? []).map((l, i) => ({ item: l, path: `/context/links/${i}` })),
    ...(req.context?.attachments ?? []).map((a, i) => ({ item: a, path: `/context/attachments/${i}` })),
  ];
  for (const { item, path } of items) {
    if (item.mustOpen && !opened.has(item.ref)) {
      const name = 'label' in item ? item.label : item.name;
      errors.push({ field: path, message: `"${name}" must be opened before answering`, hint: 'Open it first.' });
    }
  }
  return errors;
}

/** Only binary questions are forwarded to HITLy in APR-2. */
export function isHitlyForwardable(req: HitlRequest | null | undefined): boolean {
  return !req || req.answerType === 'binary';
}
