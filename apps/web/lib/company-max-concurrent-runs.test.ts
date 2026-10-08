/**
 * updateCompanyMaxConcurrentRuns (company settings → maxConcurrentRuns, jsonb).
 * Real lib/company.ts + @tourbillon/shared; @tourbillon/db, drizzle-orm and next/headers are mocked
 * via Module.prototype.require so no database is touched. The settings-page server action that
 * calls this is board-guarded (requireBoardSession first) and covered by server-action-guards.test.ts.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type Row = { id: string; settings: Record<string, unknown>; updatedAt?: Date };
type Cond = { c: string; val: unknown };
let rows: Row[];
let writes: number;

describe('updateCompanyMaxConcurrentRuns', () => {
  let update: typeof import('./company').updateCompanyMaxConcurrentRuns;

  before(async () => {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    const companies = new Proxy({}, { get: (_t, prop: string) => ({ c: prop }) });
    const db = {
      query: {
        companies: {
          findFirst: async ({ where }: { where: Cond }) => rows.find((r) => (r as never)[where.c] === where.val),
        },
      },
      update: () => ({
        set: (patch: Partial<Row>) => ({
          where: (where: Cond) => ({
            returning: async () => {
              writes += 1;
              const hit = rows.filter((r) => (r as never)[where.c] === where.val);
              for (const r of hit) Object.assign(r, patch);
              return hit;
            },
          }),
        }),
      }),
    };
    Module.prototype.require = function (this: { filename?: string }, id: string) {
      if (id === '@tourbillon/db') return { db, companies };
      if (id === 'drizzle-orm') return { eq: (col: { c: string }, val: unknown) => ({ c: col.c, val }), asc: () => ({}) };
      if (id === 'next/headers') return { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() };
      return originalRequire.apply(this, arguments as unknown as [string]);
    };
    ({ updateCompanyMaxConcurrentRuns: update } = await import('./company'));
  });

  beforeEach(() => {
    writes = 0;
    rows = [
      { id: 'company-a', settings: { wakeContextV2: true, tavilyApiKey: 'tvly-fake' } },
      { id: 'company-b', settings: { maxConcurrentRuns: 7 } },
    ];
  });

  it('stores a positive integer in settings jsonb and keeps the other settings', async () => {
    const updated = await update('company-a', '3');
    assert.equal(updated.settings && (updated.settings as Record<string, unknown>).maxConcurrentRuns, 3);
    assert.equal(rows[0].settings.maxConcurrentRuns, 3);
    assert.equal(rows[0].settings.wakeContextV2, true);
    assert.equal(rows[0].settings.tavilyApiKey, 'tvly-fake');
  });

  it('blank clears the cap (no cap)', async () => {
    await update('company-b', '');
    assert.equal('maxConcurrentRuns' in rows[1].settings, false);
  });

  it('rejects 0, negatives and non-integers without writing', async () => {
    for (const bad of ['0', '-1', '1.5', 'abc', 0, -3, 2.5]) {
      await assert.rejects(update('company-a', bad), /whole number of at least 1/, String(bad));
    }
    assert.equal(writes, 0);
    assert.equal('maxConcurrentRuns' in rows[0].settings, false);
  });

  it('company isolation: only the given company row changes', async () => {
    await update('company-a', '2');
    assert.equal(rows[0].settings.maxConcurrentRuns, 2);
    assert.equal(rows[1].settings.maxConcurrentRuns, 7, 'company-b untouched');
  });

  it('unknown company → error, nothing written', async () => {
    await assert.rejects(update('company-x', '2'), /Company not found/);
    assert.equal(writes, 0);
  });
});
