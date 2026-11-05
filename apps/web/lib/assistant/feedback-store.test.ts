/**
 * OBS-2: a reaction is one UPDATE of the thread's metadata, scoped to (thread, resource, agent),
 * with no read before the write. '@tourbillon/db' is replaced by a recorder (as in thread-store.test.ts);
 * the same statements are also run on PGlite (Postgres in-process) to check the jsonb merge.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dbRequire = createRequire(join(__dirname, '../../../../packages/db/package.json'));

const dialect = new PgDialect();
const executed: Array<{ sql: string; params: unknown[] }> = [];
let nextRows: unknown[] = [];
/** When set, statements run on this PGlite instance instead of the recorder. */
let pg: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>; exec: (sql: string) => Promise<unknown>; close: () => Promise<void>; closed: boolean } | null = null;
/**
 * S313-S2: every PGlite instance this file opens, watched for a prompt close.
 * Dropping `close()` from afterEach/after survives pass/fail entirely — the only
 * symptom was the leaked WASM instance keeping the process alive (this file's
 * runtime ballooned ~2.3s -> ~12.5s under load). So the convention gets a real
 * handle check: afterEach asserts the instance it closed reports `closed`.
 * S319-S1: the "every opened instance was already closed by afterEach" backstop
 * is a REAL TEST at the bottom of this describe, not an `after()` assertion —
 * a failing after() hook is not counted as a failure under `tsx --test` on
 * Node 22 (the run prints `# fail 0` and exits 0 even though the assertion
 * error is printed). Delete the afterEach close and that test fails the file.
 */
const opened: Array<{ closed: boolean; close: () => Promise<void> }> = [];

describe('OBS-2 feedback store', () => {
  let store: typeof import('./feedback-store');

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (id === '@tourbillon/db') {
        return {
          db: {
            execute: async (q: SQL) => {
              const { sql, params } = dialect.sqlToQuery(q);
              executed.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
              if (pg) return (await pg.query(sql, params)).rows;
              return nextRows;
            },
          },
        };
      }
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    store = await import('./feedback-store');
  });

  beforeEach(() => {
    executed.length = 0;
    nextRows = [{ id: 't1' }];
  });

  // S304-S4: every sibling PGlite suite closes its instance (activity-company-scope,
  // heartbeats-skipped-filter, jobs-queue-overview-skipped, observability-skipped-run-status);
  // this file leaked the WASM instance, whose live handles keep the process past the end of
  // the file — under full-suite parallel load that surfaced as a FILE-level failure (the
  // three tests themselves never failed). Close it for real in afterEach/after.
  afterEach(async () => {
    const instance = pg;
    pg = null;
    await instance?.close();
    if (instance) assert.ok(instance.closed, 'PGlite instance is closed after afterEach close() resolves');
  });

  after(async () => {
    // S313-S2/S319-S1: the per-test afterEach owns the close and asserts it; the
    // "every instance is closed" backstop is the real test below (an `after()`
    // assertion does not count as a failure under `tsx --test` on Node 22). This
    // hook only backstops a crash between open and close (close without asserting).
    const instance = pg;
    pg = null;
    await instance?.close();
  });

  const scope = { threadId: 't1', resourceId: 'company-c1:chat:free', agentId: 'a1' };
  const entry = { rating: 'down' as const, reason: 'wrong', tags: ['incorrect' as const], updatedAt: '2026-10-25T00:00:00.000Z' };

  it('one scoped UPDATE that sets only this user’s entry for this message', async () => {
    assert.equal(await store.saveAssistantMessageFeedbackRow(scope, 'm1', 'u1', entry), true);
    assert.equal(executed.length, 1);
    const [{ sql, params }] = executed;
    assert.match(sql, /^UPDATE "mastra_threads" SET metadata = jsonb_set\(COALESCE\(metadata, '\{\}'::jsonb\),/);
    assert.match(sql, /WHERE id = \$\d+ AND "resourceId" = \$\d+ AND metadata->>'agentId' = \$\d+ RETURNING id$/);
    assert.doesNotMatch(sql, /SELECT/);
    assert.ok(params.includes('{assistantFeedback}'));
    assert.ok(params.includes('m1'));
    assert.ok(params.includes('u1'));
    assert.ok(params.includes(JSON.stringify(entry)));
    assert.deepEqual(params.slice(-3), ['t1', 'company-c1:chat:free', 'a1']);
  });

  it('returns false when no thread matched the scope', async () => {
    nextRows = [];
    assert.equal(await store.saveAssistantMessageFeedbackRow(scope, 'm1', 'u1', entry), false);
  });

  it('on Postgres: replaces one user’s entry per message, keeps other users, messages and metadata', async () => {
    const { PGlite } = dbRequire('@electric-sql/pglite');
    const instance = new PGlite();
    opened.push(instance);
    pg = instance;
    await pg!.exec(`CREATE TABLE mastra_threads (id text PRIMARY KEY, "resourceId" text, title text, metadata jsonb);
      INSERT INTO mastra_threads VALUES
        ('t1', 'company-c1:chat:free', 'T', '{"agentId":"a1","assistantReadMessageId":"m0"}'),
        ('t2', 'company-c1:chat:free', 'T', '{"agentId":"a1","assistantFeedback":"not an object"}');`);
    const up = { ...entry, rating: 'up' as const, reason: null, tags: [] };
    assert.equal(await store.saveAssistantMessageFeedbackRow(scope, 'm1', 'u1', up), true);
    assert.equal(await store.saveAssistantMessageFeedbackRow(scope, 'm1', 'u1', entry), true);
    assert.equal(await store.saveAssistantMessageFeedbackRow(scope, 'm1', 'u2', up), true);
    assert.equal(await store.saveAssistantMessageFeedbackRow(scope, 'm2', 'u1', up), true);
    assert.equal(await store.saveAssistantMessageFeedbackRow({ ...scope, agentId: 'a2' }, 'm1', 'u1', up), false);
    assert.equal(await store.saveAssistantMessageFeedbackRow({ ...scope, resourceId: 'company-c2:chat:free' }, 'm1', 'u1', up), false);
    assert.equal(await store.saveAssistantMessageFeedbackRow({ ...scope, threadId: 't2' }, 'm1', 'u1', up), true);

    const rows = (await pg!.query('SELECT id, metadata FROM mastra_threads ORDER BY id', [])).rows as Array<{ id: string; metadata: any }>;
    assert.deepEqual(rows[0].metadata, {
      agentId: 'a1',
      assistantReadMessageId: 'm0',
      assistantFeedback: { m1: { u1: entry, u2: up }, m2: { u1: up } },
    });
    assert.deepEqual(rows[1].metadata, { agentId: 'a1', assistantFeedback: { m1: { u1: up } } });
  });

  // S319-S1: a failing `after()` hook does NOT count as a failure under `tsx --test`
  // on Node 22 (`# fail 0`, rc 0, only an AssertionError line in the log), so the
  // S313-S2 backstop - every instance opened by this file must already be closed by
  // the per-test hook - runs here as a REAL test (last, so every afterEach has run).
  // Drop the afterEach close and this test goes RED with a counted failure.
  it('every PGlite instance opened by this file was closed by the per-test hook', () => {
    const stillOpen = opened.filter((instance) => !instance.closed);
    assert.equal(stillOpen.length, 0, `every PGlite instance opened by this file must already be closed by afterEach (${stillOpen.length} open)`);
  });

  /**
   * S323-S2 (Refs #323): declaration-order guard for the backstop above.
   * The backstop is only honest because it is the LAST declared test — every
   * afterEach has run by the time `opened` is inspected. It breaks silently if
   * a test is appended after it, if it is moved earlier, or if the runner ever
   * reorders/repeats tests. This guard reads THIS file's own source and pins
   * the order; it must itself stay the last declared test, which it checks too.
   * Backstop names are assembled by concatenation so the guard's own literals
   * can never satisfy the declaration scan (self-reading-pin hazard).
   */
  it('S323-S2 declaration-order guard: close-backstop is last before this guard', () => {
    const src = readFileSync(join(__dirname, 'feedback-store.test.ts'), 'utf8');
    const BACKSTOP = 'every PGlite instance opened by this file was closed by the per' + '-test hook';
    const GUARD = 'S323-S2 declaration-order guard: close-backstop is last before this guard';
    // S325-S2 (#325 review soft): the old scan matched only the single-quoted declaration
    // form, so an appended declaration in double quotes, backticks, or with a skip/only/todo
    // modifier stayed invisible and silently made the backstop not-last. The scan now covers
    // all three quote styles and the modifier forms. Self-reading-pin hazard: NOTHING in this
    // file may contain a literal declaration token (the two chars of the runner function name
    // followed by an open paren then any quote) outside real declarations — including comments
    // and this one. The pattern's own source never self-matches (after the optional modifier
    // the next char is a regex metachar, never whitespace-then-quote); keep both rules.
    const decls = [...src.matchAll(/\bit(?:\.(?:skip|only|todo))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)]
      .map((m) => ({ name: m[2], pos: m.index }));
    const backstops = decls.filter((d) => d.name === BACKSTOP);
    const guards = decls.filter((d) => d.name === GUARD);
    assert.equal(backstops.length, 1, `the close-backstop must be declared exactly once (found ${backstops.length})`);
    assert.equal(guards.length, 1, `the order guard must be declared exactly once (found ${guards.length})`);
    // The backstop must be the SECOND-TO-LAST declared test — only the guard
    // may follow it. Kills: deletion, moving earlier, and appending tests after it.
    const last = decls[decls.length - 1];
    const secondLast = decls[decls.length - 2];
    assert.equal(last.name, GUARD, 'this guard must remain the last declared test in the file');
    assert.equal(secondLast.name, BACKSTOP, 'the close-backstop must be the last real test (declaration order is load-bearing — see comment above)');
    // The backstop must still READ the tracker: kill a gutted backstop that was
    // left in place positionally but no longer inspects `opened`.
    const body = src.slice(backstops[0].pos, guards[0].pos);
    assert.match(body, /opened\.filter/, 'backstop must filter the opened-instance tracker');
    assert.match(body, /assert\.equal\(stillOpen\.length, 0/, 'backstop must assert zero open instances');
    // Reorder protection at the runner level: this Node build has no
    // --test-shuffle (measured on Node 22), and neither the package script nor
    // the runner may introduce one — under shuffling the backstop could run
    // before the PGlite test and pass vacuously.
    // S325-S1 (#325 review soft): shuffle was only one of the reordering knobs. Node 24
    // ships --test-randomize and --test-random-seed (measured on 24.22.1), which the old
    // /shuffle/ regex missed entirely — a shuffled CI run stayed GREEN. Ban the whole token
    // family. Honest caveat: the web runner forwards extra CLI args to tsx, so an operator
    // CAN still shuffle locally via `pnpm test -- --test-randomize` — that is a deliberate
    // local action; the pin's job is that the committed script, the runner, and ci.yml never
    // do it by default.
    const webPkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.doesNotMatch(webPkg.scripts.test ?? '', /shuffle|randomi[sz]e|random[-_]seed|randomSeed/, 'web test script must not shuffle/randomize test order');
    const runner = readFileSync(join(__dirname, '../../scripts/run-tests.mjs'), 'utf8');
    assert.doesNotMatch(runner, /test-shuffle|test-randomize|random-seed|randomSeed/, 'the web test runner must not shuffle/randomize test order');
  });
});
