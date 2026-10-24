/**
 * APR-2: `/o/<token>`, the tracked way a reviewer opens a link or file of an approval.
 *
 * - Board session only (the proxy sends anyone else to /unlock); the token must belong to the
 *   active company. An unknown token, or another company's, is 404.
 * - GET records an `opened` event for the token's item (only while the approval is pending), then
 *   redirects 303 to the URL stored in the request, with `Referrer-Policy: no-referrer` so the
 *   token never reaches the target. The target is never fetched by the server.
 * - An inline attachment is served from the request itself (download, sandboxed, no sniffing).
 * - HEAD answers the same status and records nothing.
 * - The token is never logged.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db, approvals } from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';
import { publicOriginFromRequest } from '@tourbillon/shared';
import { requireBoardCompany } from '@/lib/board-route-auth';
import { DETAILS_ITEM_REF, hitlRequestOf, recordReviewerEvent, resolveLinkToken } from '@/lib/hitl-host';

const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } as const;

function notFound() {
  return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });
}

type Target =
  | { kind: 'redirect'; url: string }
  | { kind: 'inline'; name: string; mediaType: string; bytes: Buffer };

async function resolveTarget(req: NextRequest, token: string): Promise<{ status: 401 | 403 | 404 } | { target: Target; companyId: string; approvalId: string; itemRef: string }> {
  const auth = await requireBoardCompany(req);
  if (!auth.ok) return { status: auth.response.status === 403 ? 403 : 401 };
  const link = await resolveLinkToken(token, auth.value.id);
  if (!link) return { status: 404 };
  const approval = await db.query.approvals.findFirst({
    where: and(eq(approvals.id, link.approvalId), eq(approvals.companyId, auth.value.id)),
  });
  if (!approval) return { status: 404 };
  const base = { companyId: auth.value.id, approvalId: approval.id, itemRef: link.itemRef };
  if (link.itemRef === DETAILS_ITEM_REF) {
    return { ...base, target: { kind: 'redirect', url: new URL(`/approval/${approval.id}`, publicOriginFromRequest(req)).toString() } };
  }
  const request = hitlRequestOf(approval);
  const l = request?.context?.links?.find((x) => x.ref === link.itemRef);
  if (l) return { ...base, target: { kind: 'redirect', url: l.url } };
  const a = request?.context?.attachments?.find((x) => x.ref === link.itemRef);
  if (a?.url) return { ...base, target: { kind: 'redirect', url: a.url } };
  if (a?.inline) {
    return { ...base, target: { kind: 'inline', name: a.name, mediaType: a.mediaType, bytes: Buffer.from(a.inline, 'base64') } };
  }
  return { status: 404 };
}

function respond(target: Target): NextResponse {
  if (target.kind === 'redirect') {
    return new NextResponse(null, { status: 303, headers: { ...NO_STORE, Location: target.url } });
  }
  const safeName = target.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'attachment';
  return new NextResponse(new Uint8Array(target.bytes), {
    status: 200,
    headers: {
      ...NO_STORE,
      'Content-Type': target.mediaType,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    },
  });
}

function failure(status: 401 | 403 | 404) {
  if (status === 404) return notFound();
  return NextResponse.json({ error: status === 403 ? 'Forbidden: board only' : 'Unauthorized' }, { status, headers: NO_STORE });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await resolveTarget(req, token);
  if ('status' in r) return failure(r.status);
  if (r.itemRef !== DETAILS_ITEM_REF) {
    try {
      await recordReviewerEvent({ companyId: r.companyId, approvalId: r.approvalId, type: 'opened', itemRef: r.itemRef });
    } catch (err) {
      // Value-free: ids only, never the token.
      console.error('[hitl-open] could not record opened event', { approvalId: r.approvalId, itemRef: r.itemRef }, err instanceof Error ? err.name : 'error');
    }
  }
  return respond(r.target);
}

/** HEAD never counts as opening (link checkers and previews send it). */
export async function HEAD(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await resolveTarget(req, token);
  if ('status' in r) return new NextResponse(null, { status: r.status, headers: NO_STORE });
  const res = respond(r.target);
  return new NextResponse(null, { status: res.status, headers: res.headers });
}
