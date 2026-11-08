#!/usr/bin/env node
/**
 * #114 real-Postgres evidence runner (CI job `pg-114-run-id-header`).
 * Runs ONE pinned file against a disposable loopback `tb114_*` database (schema applied
 * beforehand with `pnpm --filter @tourbillon/db migrate`), then checks the TAP output against
 * the pinned manifest: every expected test name passed, nothing failed, no unexpected or missing
 * tests, and the process exited 0 on its own (no --test-force-exit, no name pattern).
 */
import { readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(WEB_ROOT, 'lib/auth/run-id-header-114.pg-manifest.json'), 'utf8'));

const url = new URL(process.env.DATABASE_URL ?? 'postgres://x@invalid/none');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.slice(1).startsWith('tb114_')) {
  console.error('run-pg-114-tests: DATABASE_URL must point at a loopback disposable tb114_* database');
  process.exit(2);
}

const tsx = join(WEB_ROOT, 'node_modules', '.bin', 'tsx');
const r = spawnSync(tsx, ['--test', '--test-reporter=tap', manifest.file], {
  cwd: WEB_ROOT, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024,
});
// Synchronous writes: process.exit() on a pipe can drop buffered async stdout (CI logs).
writeSync(1, r.stdout ?? '');
writeSync(2, r.stderr ?? '');
if (r.error) { console.error(r.error.message); process.exit(1); }

const leafOk = new Set();
const notOk = [];
const lines = (r.stdout ?? '').split('\n');
for (let i = 0; i < lines.length; i++) {
  const m = /^\s*(not ok|ok) \d+ - (.*)$/.exec(lines[i]);
  if (!m) continue;
  const isSuite = /type: 'suite'/.test(lines.slice(i + 1, i + 5).join('\n'));
  if (isSuite) continue;
  if (m[1] === 'ok') leafOk.add(m[2]); else notOk.push(m[2]);
}
const expected = new Set(manifest.tests);
const missing = [...expected].filter((t) => !leafOk.has(t));
const extra = [...leafOk].filter((t) => !expected.has(t));
let bad = false;
if (r.status !== 0) { console.error(`run-pg-114-tests: test process exit ${r.status}`); bad = true; }
if (notOk.length) { console.error(`run-pg-114-tests: failed: ${notOk.join(' | ')}`); bad = true; }
if (missing.length) { console.error(`run-pg-114-tests: manifest tests not passed: ${missing.join(' | ')}`); bad = true; }
if (extra.length) { console.error(`run-pg-114-tests: tests not in manifest: ${extra.join(' | ')}`); bad = true; }
writeSync(1, `run-pg-114-tests: ${leafOk.size}/${expected.size} pinned tests passed, exit ${r.status}, ${bad ? 'FAIL' : 'OK'}\n`);
process.exitCode = bad ? 1 : 0;
