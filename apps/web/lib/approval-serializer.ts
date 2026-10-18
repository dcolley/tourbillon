/**
 * The one place an approval row becomes a read model (agent REST list/detail and create
 * response, control-plane MCP, mobile). Every caller goes through `serializeApproval`, so:
 *
 * - Only allow-listed columns leave the server (new columns stay private by default).
 * - Reserved server-side payload keys (`RESERVED_APPROVAL_PAYLOAD_KEYS`) are dropped.
 * - The payload is scrubbed with the shared approval redactor (credential-like keys at any
 *   depth, Bearer/Basic values, URL query strings, token shapes, known secret values) and
 *   bounded in size and depth.
 * - `note` and `hitlyError` are scrubbed with the same redactor, including any value that
 *   appears under a credential-like key in the payload.
 */
import type { Approval } from '@tourbillon/db';
import { collectSecretValueEntries } from '@tourbillon/shared';
import {
  collectValuesUnderSensitiveKeys,
  createApprovalRedactor,
  type DisplayCap,
} from './approval-redaction';

/** Payload keys written by the server only: never accepted from callers, never returned. */
export const RESERVED_APPROVAL_PAYLOAD_KEYS: readonly string[] = ['hitlyResumeToken'];

/** Bounds for API reads: generous for real payloads, but no unbounded depth or size. */
export const APPROVAL_READ_CAP: DisplayCap = {
  maxDepth: 32,
  maxStringChars: 20_000,
  maxArrayItems: 500,
  maxObjectKeys: 500,
  maxTotalChars: 200_000,
};

export interface SerializedApproval {
  id: string;
  companyId: string;
  type: string;
  status: Approval['status'];
  requestedByAgentId: string | null;
  decidedByUserId: string | null;
  issueIds: string[];
  payload: Record<string, unknown>;
  note: string | null;
  decidedAt: Date | null;
  hitlyApprovalId: string | null;
  hitlyError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SerializeApprovalOptions {
  /** Extra known secret values (company settings, vault, provider keys) to scrub everywhere. */
  knownSecrets?: Iterable<string | null | undefined>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Shallow copy of a payload object without reserved server-side keys (non-objects become `{}`). */
export function stripReservedPayloadKeys(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!RESERVED_APPROVAL_PAYLOAD_KEYS.includes(k)) out[k] = v;
  }
  return out;
}

/** Secret values held in a company's settings (`collectSecretValueEntries`), for `knownSecrets`. */
export function companySettingsSecretValues(settings: unknown): string[] {
  return collectSecretValueEntries(settings).map(([, v]) => v);
}

export function serializeApproval(
  approval: Approval,
  opts: SerializeApprovalOptions = {},
): SerializedApproval {
  const rawPayload = stripReservedPayloadKeys(approval.payload);
  const legacy = isRecord(approval.payload) ? approval.payload.hitlyResumeToken : undefined;
  const redactor = createApprovalRedactor([
    ...(opts.knownSecrets ?? []),
    ...collectValuesUnderSensitiveKeys(rawPayload),
    ...(typeof legacy === 'string' ? [legacy] : []),
  ]);
  const { value } = redactor.capped(rawPayload, APPROVAL_READ_CAP);
  return {
    id: approval.id,
    companyId: approval.companyId,
    type: approval.type,
    status: approval.status,
    requestedByAgentId: approval.requestedByAgentId ?? null,
    decidedByUserId: approval.decidedByUserId ?? null,
    issueIds: approval.issueIds ?? [],
    payload: isRecord(value) ? value : {},
    note: typeof approval.note === 'string' ? redactor.text(approval.note) : null,
    decidedAt: approval.decidedAt ?? null,
    hitlyApprovalId: approval.hitlyApprovalId ?? null,
    hitlyError: typeof approval.hitlyError === 'string' ? redactor.text(approval.hitlyError) : null,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
  };
}
