import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Approval } from '@tourbillon/db';
import {
  APPROVAL_READ_CAP,
  RESERVED_APPROVAL_PAYLOAD_KEYS,
  serializeApproval,
  stripReservedPayloadKeys,
} from './approval-serializer';

const RESUME = 'Rsm-0123456789abcdefghijklmnopqrstuvwxyzABCD';
const NESTED = 'nested-credential-value-9f8e7d6c5b4a';

function row(over: Partial<Approval> & Record<string, unknown> = {}): Approval {
  return {
    id: 'appr-1',
    companyId: 'co-1',
    type: 'request_board_approval',
    status: 'pending',
    requestedByAgentId: 'agent-1',
    decidedByUserId: null,
    issueIds: [],
    payload: {},
    note: null,
    decidedAt: null,
    hitlyApprovalId: null,
    hitlyError: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  } as Approval;
}

describe('approval serializer', () => {
  it('reserves the HITLy resume key', () => {
    assert.ok(RESERVED_APPROVAL_PAYLOAD_KEYS.includes('hitlyResumeToken'));
    assert.deepEqual(stripReservedPayloadKeys({ title: 't', hitlyResumeToken: 'x' }), { title: 't' });
    assert.deepEqual(stripReservedPayloadKeys(null), {});
    assert.deepEqual(stripReservedPayloadKeys(['a']), {});
  });

  it('drops a stored resume token and scrubs every echo of it', () => {
    const out = serializeApproval(
      row({
        payload: { title: 'Hire', summary: `see ${RESUME}`, hitlyResumeToken: RESUME },
        note: `note ${RESUME}`,
        hitlyError: `HITLy ingest HTTP 400: https://tb.example/api/approvals/a/hitly-resume?token=${RESUME}`,
      }),
    );
    const json = JSON.stringify(out);
    assert.ok(!json.includes(RESUME), json);
    assert.ok(!('hitlyResumeToken' in out.payload));
    assert.equal(out.payload.title, 'Hire');
  });

  it('redacts credential-like keys at any depth and their values elsewhere', () => {
    const out = serializeApproval(
      row({
        payload: {
          title: 'Deploy',
          args: { config: { headers: { 'x-api-key': NESTED }, list: [{ resumeToken: NESTED }] } },
          maxTokens: 512,
        },
        note: `the key was ${NESTED}`,
      }),
    );
    const json = JSON.stringify(out);
    assert.ok(!json.includes(NESTED), json);
    assert.equal((out.payload as { maxTokens: number }).maxTokens, 512, 'token counts are kept');
    assert.equal(out.payload.title, 'Deploy');
  });

  it('scrubs Bearer values, URL query strings and known secret values', () => {
    const known = 'company-settings-secret-abcdef123456';
    const out = serializeApproval(
      row({
        payload: { summary: `Authorization: Bearer abc.def.ghi and ${known}`, link: 'https://x.example/cb?token=qqq' },
      }),
      { knownSecrets: [known] },
    );
    const json = JSON.stringify(out);
    assert.ok(!json.includes('abc.def.ghi'));
    assert.ok(!json.includes(known));
    assert.ok(!json.includes('token=qqq'));
  });

  it('returns only allow-listed columns', () => {
    const out = serializeApproval(row({ tokenHash: 'deadbeef', internalColumn: 'x' } as never));
    assert.deepEqual(Object.keys(out).sort(), [
      'companyId', 'createdAt', 'decidedAt', 'decidedByUserId', 'hitlyApprovalId', 'hitlyError',
      'id', 'issueIds', 'note', 'payload', 'requestedByAgentId', 'status', 'type', 'updatedAt',
    ]);
  });

  it('bounds payload depth', () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 5_000; i++) deep = { n: deep };
    const out = serializeApproval(row({ payload: deep }));
    const json = JSON.stringify(out);
    assert.ok(json.length < 10_000);
    assert.match(json, new RegExp(`nested deeper than ${APPROVAL_READ_CAP.maxDepth} levels`));
  });
});
