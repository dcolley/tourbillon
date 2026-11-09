/**
 * #114 real-Postgres evidence. NOT part of the closed-port unit suite: run through
 * `node scripts/run-pg-114-tests.mjs` against a DISPOSABLE Postgres whose schema was applied with
 * the repo's normal runner (`pnpm --filter @tourbillon/db migrate`). Refuses any DATABASE_URL that
 * is not loopback with a database name starting `tb114_`.
 *
 * Real: route handlers, token auth (HMAC + persisted run/agent/company lookup), @tourbillon/db
 * (postgres-js + Drizzle), addIssueComment, board session verification and the board comment
 * server action. Instrumented (not weakened): the wake boundary (`@/lib/wake-client`, records
 * calls instead of reaching Redis) and Next request context for the server action
 * (`next/headers`, `next/cache`, `next/navigation`).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const url = new URL(process.env.DATABASE_URL ?? 'postgres://x@invalid/none');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.slice(1).startsWith('tb114_')) {
  throw new Error('run-id-header-114 pg test: DATABASE_URL must be a loopback disposable tb114_* database');
}

const SECRET = 'synthetic-agent-token-secret-114-pg-0123456789';
const BOARD_SECRET = 'synthetic-board-secret-114-pg-0123456789abcdef';
const env = process.env as Record<string, string | undefined>;
const savedEnv = { a: env.TOURBILLON_AGENT_TOKEN_SECRET, b: env.BETTER_AUTH_SECRET, c: env.TOURBILLON_BOARD_SECRET };
const SNAP_DIR = env.TB114_SNAPSHOT_DIR;

type Row = Record<string, unknown>;
const b64 = (s: string) => Buffer.from(s).toString('base64url');
function signed(prefix: 'pm_run_' | 'pm_chat_', claims: Row) {
  const iat = Math.floor(Date.now() / 1000);
  const body = `${prefix}${b64(JSON.stringify({ v: 1, ...claims, iat, exp: iat + 600 }))}`;
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}
const runToken = (runId: string, agentId: string, companyId: string) => signed('pm_run_', { runId, agentId, companyId });
const TOKEN_A = () => runToken('run-a', 'agent-a1', 'company-a');
const CHAT_A = () => signed('pm_chat_', { chatSessionId: 'chat-agent-a1', agentId: 'agent-a1', companyId: 'company-a' });

let wakes: unknown[] = [];
let redirects: string[] = [];
let ctxHeaders = new Headers();
let ctxCookies = new Map<string, string>();
let dbm: { db: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
let sql: any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = (req: NextRequest, ctx: { params: Promise<{ issueId: string }> }) => Promise<Response>;
const H: Record<string, Handler> = {};
let boardComment: (prev: unknown, fd: FormData) => Promise<{ error: string | null } | undefined>;
let createBoardSessionToken: () => Promise<string | null>;
const Module = require('module');
const originalRequire = Module.prototype.require;

async function q(text: string): Promise<Row[]> {
  const r = await dbm.db.execute(sql.raw(text));
  return (Array.isArray(r) ? r : r.rows) as Row[];
}

async function seed() {
  wakes = [];
  await q('TRUNCATE companies CASCADE');
  await q(`
    insert into companies (id, name, slug, issue_prefix) values
      ('company-a','Co A','co-a','CA'), ('company-b','Co B','co-b','CB');
    insert into agents (id, company_id, name, role, title, url_key) values
      ('agent-a1','company-a','A1','engineer','A1','a1'),
      ('agent-a2','company-a','A2','engineer','A2','a2'),
      ('agent-b1','company-b','B1','engineer','B1','b1');
    insert into heartbeat_runs (id, company_id, agent_id, invocation_source, status, started_at) values
      ('run-a','company-a','agent-a1','assignment','running','2026-01-01T00:00:00Z'),
      ('run-b','company-a','agent-a1','assignment','running','2026-01-01T00:00:00Z'),
      ('run-c','company-a','agent-a2','assignment','running','2026-01-01T00:00:00Z'),
      ('run-d','company-b','agent-b1','assignment','running','2026-01-01T00:00:00Z'),
      ('run-done','company-a','agent-a1','assignment','succeeded','2026-01-01T00:00:00Z');
    insert into issues (id, company_id, identifier, title, status, priority, assignee_agent_id,
                        checkout_run_id, execution_locked_at, execution_agent_name_key, created_at, updated_at) values
      ('iss-free','company-a','CA-1','free','todo','medium','agent-a1',null,null,null,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
      ('iss-b','company-a','CA-2','locked by B','in_progress','medium','agent-a1','run-b','2026-01-01T00:00:00Z','agent-a1','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
      ('iss-c','company-a','CA-3','locked by C','in_progress','medium','agent-a2','run-c','2026-01-01T00:00:00Z','agent-a2','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
      ('iss-d','company-b','CB-1','locked by D','in_progress','medium','agent-b1','run-d','2026-01-01T00:00:00Z','agent-b1','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
      ('iss-d-free','company-b','CB-2','foreign free','todo','medium','agent-b1',null,null,null,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
  `);
}

async function snapshot(): Promise<string> {
  const out: Record<string, Row[]> = {};
  for (const t of ['heartbeat_runs', 'issues', 'activity_log']) {
    out[t] = await q(`select * from ${t} order by id`);
  }
  return JSON.stringify({ db: out, wakes }, (_k, v) => (v instanceof Date ? v.toISOString() : v), 1);
}
function saveSnap(name: string, before: string, afterS: string) {
  if (!SNAP_DIR) return;
  mkdirSync(SNAP_DIR, { recursive: true });
  writeFileSync(join(SNAP_DIR, `${name.replace(/[^a-z0-9-]+/gi, '_')}.json`),
    `{"before":${before},"after":${afterS}}\n`);
}
async function activity(): Promise<Row[]> {
  return q(`select actor_type, actor_id, action, entity_id, details from activity_log order by created_at, id`);
}

const BODY: Record<string, Row> = {
  checkout: { agentId: 'agent-a1', expectedStatuses: ['todo', 'in_progress'] },
  comment: { body: 'synthetic comment 114' },
  patch: { status: 'in_review', priority: 'high', assigneeAgentId: 'agent-a2', comment: 'synthetic 114' },
};
const OK_STATUS: Record<string, number> = { checkout: 200, comment: 201, patch: 200 };
const PATH: Record<string, (id: string) => string> = {
  checkout: (id) => `/api/issues/${id}/checkout`,
  comment: (id) => `/api/issues/${id}/comments`,
  patch: (id) => `/api/issues/${id}`,
};
const METHOD: Record<string, string> = { checkout: 'POST', comment: 'POST', patch: 'PATCH' };

function call(route: string, issueId: string, auth: { bearer?: string; cookie?: string }, header?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  if (auth.cookie) headers.cookie = auth.cookie;
  if (header !== undefined) headers['x-paperclip-run-id'] = header;
  const req = new NextRequest(`http://localhost${PATH[route](issueId)}`, {
    method: METHOD[route], headers, body: JSON.stringify(BODY[route]),
  });
  return H[route](req, { params: Promise.resolve({ issueId }) });
}

describe('#114 real PG', () => {
  before(async () => {
    env.TOURBILLON_AGENT_TOKEN_SECRET = SECRET;
    env.BETTER_AUTH_SECRET = BOARD_SECRET;
    env.TOURBILLON_BOARD_SECRET = BOARD_SECRET;
    Module.prototype.require = function (id: string) {
      if (id === '@/lib/wake-client' || id.endsWith('/lib/wake-client')) {
        return { enqueueHeartbeat: async (w: unknown) => { wakes.push(w); return { queued: true }; } };
      }
      if (id === 'next/headers') {
        return {
          headers: async () => ctxHeaders,
          cookies: async () => ({ get: (n: string) => (ctxCookies.has(n) ? { name: n, value: ctxCookies.get(n) } : undefined) }),
        };
      }
      if (id === 'next/cache') return { revalidatePath: () => {}, revalidateTag: () => {} };
      if (id === 'next/navigation') return { redirect: (u: string) => { redirects.push(u); }, notFound: () => {} };
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    dbm = await import('@tourbillon/db');
    ({ sql } = await import('drizzle-orm'));
    H.checkout = (await import('../../app/api/issues/[issueId]/checkout/route')).POST as Handler;
    H.comment = (await import('../../app/api/issues/[issueId]/comments/route')).POST as Handler;
    H.patch = (await import('../../app/api/issues/[issueId]/route')).PATCH as Handler;
    boardComment = (await import('../../app/(dashboard)/issue/actions')).commentOnIssueAction as typeof boardComment;
    ({ createBoardSessionToken } = await import('../board-auth'));
  });

  after(async () => {
    Module.prototype.require = originalRequire;
    // Test soft: restore absent keys by deleting them, not by assigning undefined.
    for (const [k, v] of [['TOURBILLON_AGENT_TOKEN_SECRET', savedEnv.a], ['BETTER_AUTH_SECRET', savedEnv.b], ['TOURBILLON_BOARD_SECRET', savedEnv.c]] as const) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const client = (globalThis as { postgresClient?: { end: () => Promise<void> } }).postgresClient;
    await client?.end();
  });

  beforeEach(async () => {
    ctxHeaders = new Headers();
    ctxCookies = new Map();
    redirects = [];
    await seed();
  });

  const MISMATCH: [string, string][] = [
    ['B same agent', 'run-b'], ['C other agent', 'run-c'], ['D other company', 'run-d'],
    ['finished run', 'run-done'], ['unknown run', 'run-unknown'], ['empty', ''],
  ];
  const TARGETS = ['iss-free', 'iss-b', 'iss-c', 'iss-d'];

  for (const route of ['checkout', 'comment', 'patch']) {
    describe(route, () => {
      for (const [label, header] of MISMATCH) {
        it(`${route}: token A + header ${label} -> 403 run_id_mismatch, zero persisted change`, async () => {
          for (const target of TARGETS) {
            const before = await snapshot();
            const res = await call(route, target, { bearer: TOKEN_A() }, header);
            assert.equal(res.status, 403, `${target}`);
            assert.equal(((await res.json()) as Row).code, 'run_id_mismatch');
            const afterS = await snapshot();
            if (target === 'iss-b') saveSnap(`${route}-mismatch-${label}-${target}`, before, afterS);
            assert.equal(afterS, before, `${target}: DB unchanged`);
          }
        });
      }

      for (const [label, header] of [['absent', undefined], ['matching A', 'run-a']] as const) {
        it(`${route}: token A + header ${label} on own free issue -> ${OK_STATUS[route]}, attributed to run A only`, async () => {
          const before = await snapshot();
          const res = await call(route, 'iss-free', { bearer: TOKEN_A() }, header);
          assert.equal(res.status, OK_STATUS[route]);
          const acts = await activity();
          assert.ok(acts.length >= 1);
          for (const a of acts) {
            assert.equal(a.actor_id, 'agent-a1');
            assert.equal((a.details as Row).runId, 'run-a');
          }
          const [iss] = await q(`select checkout_run_id from issues where id='iss-free'`);
          if (route === 'checkout') assert.equal(iss.checkout_run_id, 'run-a');
          const afterS = await snapshot();
          assert.doesNotMatch(afterS, /"runId": "run-[bcd]"/);
          saveSnap(`${route}-positive-${label}`, before, afterS);
        });
      }

      it(`${route}: foreign-company issue with header absent or matching -> 403 Forbidden, zero persisted change`, async () => {
        for (const header of [undefined, 'run-a']) {
          for (const target of ['iss-d', 'iss-d-free']) {
            const before = await snapshot();
            const res = await call(route, target, { bearer: TOKEN_A() }, header);
            assert.equal(res.status, 403);
            assert.notEqual(((await res.json()) as Row).code, 'run_id_mismatch');
            assert.equal(await snapshot(), before);
          }
        }
      });

      for (const [label, header] of [['absent', undefined], ['matching chat session', 'chat-agent-a1']] as const) {
        it(`${route}: chat token + header ${label} -> ${OK_STATUS[route]}, attributed to the chat session`, async () => {
          const res = await call(route, 'iss-free', { bearer: CHAT_A() }, header);
          assert.equal(res.status, OK_STATUS[route]);
          for (const a of await activity()) {
            assert.equal(a.actor_id, 'agent-a1');
            assert.equal((a.details as Row).runId, 'chat-agent-a1');
          }
        });
      }

      it(`${route}: chat token + run id header -> 403 run_id_mismatch, zero persisted change`, async () => {
        for (const header of ['run-a', 'run-b', 'run-c', 'run-d']) {
          const before = await snapshot();
          const res = await call(route, 'iss-free', { bearer: CHAT_A() }, header);
          assert.equal(res.status, 403);
          assert.equal(((await res.json()) as Row).code, 'run_id_mismatch');
          assert.equal(await snapshot(), before);
        }
      });

      it(`${route}: board session cookie + run id header, no bearer -> 401, header grants no authority`, async () => {
        const session = await createBoardSessionToken();
        assert.ok(session, 'board session minted');
        for (const header of [undefined, 'run-a', 'run-b']) {
          const before = await snapshot();
          const res = await call(route, 'iss-free', { cookie: `tourbillon_board_session=${session}; active_company_id=company-a` }, header);
          assert.equal(res.status, 401);
          assert.equal(await snapshot(), before);
        }
      });
    });
  }

  it('checkout: A (absent or matching header) on B- and C-held locks -> 409 lock_conflict, lock unchanged; holder B -> 200', async () => {
    for (const header of [undefined, 'run-a']) {
      for (const target of ['iss-b', 'iss-c']) {
        const before = await snapshot();
        const res = await call('checkout', target, { bearer: TOKEN_A() }, header);
        assert.equal(res.status, 409);
        assert.equal(((await res.json()) as Row).code, 'lock_conflict');
        assert.equal(await snapshot(), before);
      }
    }
    const holder = await call('checkout', 'iss-b', { bearer: runToken('run-b', 'agent-a1', 'company-a') }, 'run-b');
    assert.equal(holder.status, 200);
    const [iss] = await q(`select checkout_run_id from issues where id='iss-b'`);
    assert.equal(iss.checkout_run_id, 'run-b');
  });

  it('board comment server action still works with a run id header present (user attribution, no run)', async () => {
    const session = await createBoardSessionToken();
    ctxCookies.set('tourbillon_board_session', session!);
    ctxCookies.set('active_company_id', 'company-a');
    ctxHeaders = new Headers({ 'x-paperclip-run-id': 'run-b' });
    const fd = new FormData();
    fd.set('issueId', 'iss-free');
    fd.set('comment', 'synthetic board comment 114');
    fd.set('status', 'todo');
    fd.set('priority', 'medium');
    fd.set('assigneeAgentId', 'agent-a1');
    const res = await boardComment({ error: null }, fd);
    assert.equal(res, undefined, 'success path ends in redirect, no error state');
    assert.deepEqual(redirects, ['/issue/iss-free?saved=1']);
    const acts = (await activity()).filter((a) => a.action === 'issue.commented');
    assert.equal(acts.length, 1);
    assert.equal(acts[0].actor_type, 'user');
    assert.equal((acts[0].details as Row).runId, undefined);
  });

  it('board comment server action without a board session is refused', async () => {
    ctxHeaders = new Headers({ 'x-paperclip-run-id': 'run-a' });
    const fd = new FormData();
    fd.set('issueId', 'iss-free');
    fd.set('comment', 'should not land');
    await assert.rejects(boardComment({ error: null }, fd));
    assert.equal((await activity()).length, 0);
  });
});
