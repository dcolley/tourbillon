/**
 * /api/internal/company-computer/[action] — Company Computer tool endpoint (Slice 1).
 *
 * Auth: run-scoped Bearer token (same authenticateAgentToken as all agent API).
 *
 * TWO GATES, enforced server-side here (the tools' toolset membership is irrelevant):
 *   1. companies.has_computer === true   -> else 403 company_not_provisioned
 *   2. agents.has_computer === true      -> else 403 agent_no_computer
 *
 * Slice 1 is app code only: lifecycle actions run against the Drizzle session registry
 * and the dry-run HostClient, so a seat start answers 503 host_start_refused until the
 * Ops ensure contract exists and CC_ALLOW_START=1 (Derek enables). Desktop actions
 * (screenshot/click/typeText/openBrowser exec step) answer 503 ops_contract_missing.
 * Slice-2 actions (file manager, terminal, pressKey, mouseMove, scroll) answer 501.
 *
 * S282-S6 (defence in depth): the agent loaded by runCtx.agentId must belong to
 * runCtx.companyId — otherwise 403 agent_company_mismatch before any gate/host work.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, agents, companies } from '@tourbillon/db';
import { authenticateAgentToken } from '@/lib/auth/agent-token-auth';
import {
  GateError,
  HostBackendUnavailableError,
  HostStartRefusedError,
  InvalidRefError,
  SeatCapExceededError,
  createSession,
  destroySession,
  getSession,
  isComputerAction,
  touchSession,
  type ComputerContext,
} from '@tourbillon/company-computer';
import {
  createDrizzleSessionStore,
  getCompanyComputerHostClient,
} from '@/lib/company-computer-host';

export const runtime = 'nodejs';

const openBrowserSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//.test(u), 'only http(s) URLs are allowed')
    .optional(),
});
const clickSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  button: z.enum(['left', 'right', 'middle']).default('left'),
});
const typeTextSchema = z.object({
  text: z.string().min(1).max(4096),
});

function gateResponse(err: unknown): NextResponse {
  if (err instanceof GateError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: 403 });
  }
  if (err instanceof HostStartRefusedError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: 503 });
  }
  if (err instanceof HostBackendUnavailableError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: 503 });
  }
  if (err instanceof InvalidRefError) {
    return NextResponse.json({ error: 'invalid_ref', message: err.message }, { status: 400 });
  }
  if (err instanceof SeatCapExceededError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: 429 });
  }
  throw err;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ action: string }> },
) {
  const { action } = await params;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const runCtx = await authenticateAgentToken(token);
  if (!runCtx) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  if (!isComputerAction(action)) {
    return NextResponse.json({ error: 'unknown_action', message: `Unknown action "${action}"` }, { status: 404 });
  }

  const company = await db.query.companies.findFirst({ where: eq(companies.id, runCtx.companyId) });
  if (!company) return NextResponse.json({ error: 'company_not_found' }, { status: 404 });
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, runCtx.agentId) });
  if (!agent) return NextResponse.json({ error: 'agent_not_found' }, { status: 404 });
  // S282-S6: never act for an agent outside the run token's company (defence in depth —
  // the token issuer already binds them; a divergence means a forged/corrupt context).
  if (agent.companyId !== runCtx.companyId) {
    return NextResponse.json(
      { error: 'agent_company_mismatch', message: 'Agent does not belong to this run\'s company.' },
      { status: 403 },
    );
  }

  const ctx: ComputerContext = {
    companyId: company.id,
    agentId: agent.id,
    agentUrlKey: agent.urlKey,
    companySlug: company.slug ?? null,
    companyHasComputer: company.hasComputer === true,
    agentHasComputer: agent.hasComputer === true,
  };

  const store = createDrizzleSessionStore();
  const hostClient = getCompanyComputerHostClient();
  const deps = { store, hostClient };

  try {
    switch (action) {
      case 'createSession': {
        const session = await createSession(ctx, deps);
        return NextResponse.json({ session });
      }
      case 'getSession':
      case 'getSessionInfo': {
        const session = await getSession(ctx, deps, { probe: true });
        return NextResponse.json({ session });
      }
      case 'destroySession': {
        const result = await destroySession(ctx, deps);
        return NextResponse.json(result);
      }
      case 'openBrowser': {
        const parsed = openBrowserSchema.safeParse(await req.json().catch(() => ({})));
        if (!parsed.success) {
          return NextResponse.json({ error: 'invalid_input', issues: parsed.error.issues }, { status: 400 });
        }
        const session = await createSession(ctx, deps);
        if (parsed.data.url) {
          await hostClient.execInContainer(session.containerName, [
            'xdg-open',
            parsed.data.url,
          ]);
        }
        await touchSession(session.id, deps);
        return NextResponse.json({ sessionId: session.id, containerName: session.containerName });
      }
      case 'screenshot': {
        const session = await getSession(ctx, deps, { probe: true });
        if (!session || session.status !== 'running') {
          return NextResponse.json(
            { error: 'no_session', message: 'No active Computer seat. Call computerOpenBrowser first.' },
            { status: 409 },
          );
        }
        const shot = await hostClient.screenshot(session.containerName);
        await touchSession(session.id, deps);
        return NextResponse.json(shot);
      }
      case 'click': {
        const parsed = clickSchema.safeParse(await req.json().catch(() => ({})));
        if (!parsed.success) {
          return NextResponse.json({ error: 'invalid_input', issues: parsed.error.issues }, { status: 400 });
        }
        const session = await getSession(ctx, deps, { probe: true });
        if (!session || session.status !== 'running') {
          return NextResponse.json(
            { error: 'no_session', message: 'No active Computer seat. Call computerOpenBrowser first.' },
            { status: 409 },
          );
        }
        await hostClient.sendInput(session.containerName, {
          kind: 'click',
          x: parsed.data.x,
          y: parsed.data.y,
          button: parsed.data.button,
        });
        await touchSession(session.id, deps);
        return NextResponse.json({ success: true });
      }
      case 'typeText': {
        const parsed = typeTextSchema.safeParse(await req.json().catch(() => ({})));
        if (!parsed.success) {
          return NextResponse.json({ error: 'invalid_input', issues: parsed.error.issues }, { status: 400 });
        }
        const session = await getSession(ctx, deps, { probe: true });
        if (!session || session.status !== 'running') {
          return NextResponse.json(
            { error: 'no_session', message: 'No active Computer seat. Call computerOpenBrowser first.' },
            { status: 409 },
          );
        }
        await hostClient.sendInput(session.containerName, { kind: 'type', text: parsed.data.text });
        await touchSession(session.id, deps);
        return NextResponse.json({ success: true });
      }
      default: {
        // openFileManager / openTerminal / pressKey / mouseMove / scroll — Slice 2+.
        return NextResponse.json(
          { error: 'not_implemented', message: `${action} is not available in Slice 1.` },
          { status: 501 },
        );
      }
    }
  } catch (err) {
    return gateResponse(err);
  }
}
