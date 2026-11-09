#!/usr/bin/env node
import { readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
// S355-S5: every suite log must carry the SHA of the tree under test (no stale SHAs).
const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: join(WEB_ROOT, '..', '..'), encoding: 'utf8' }).stdout.trim();
console.log(`run-pg-112-tests: HEAD=${headSha}`);
const manifest = JSON.parse(readFileSync(join(WEB_ROOT, 'lib/auth/vault-oauth-state-112.pg-manifest.json'), 'utf8'));
const url = new URL(process.env.DATABASE_URL ?? 'postgres://x@invalid/none');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.slice(1).startsWith('tb112_')) {
  console.error('run-pg-112-tests: DATABASE_URL must be loopback disposable tb112_*');
  process.exit(2);
}
const tsx = join(WEB_ROOT, 'node_modules', '.bin', 'tsx');
const r = spawnSync(tsx, ['--test', '--test-reporter=tap', manifest.file], {
  cwd: WEB_ROOT, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024,
});
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
  const directive = /\s#\s*(SKIP|TODO)\b/i.exec(m[2]);
  if (directive) { notOk.push(`${m[2]} (${directive[1]})`); continue; }
  if (m[1] === 'ok') {
    if (leafOk.has(m[2])) notOk.push(`${m[2]} (duplicate)`);
    leafOk.add(m[2]);
  } else notOk.push(m[2]);
}
const expected = new Set(manifest.tests);
const missing = [...expected].filter((t) => !leafOk.has(t));
const extra = [...leafOk].filter((t) => !expected.has(t));
let bad = false;
if (r.status !== 0) { console.error(`run-pg-112-tests: test process exit ${r.status}`); bad = true; }
if (notOk.length) { console.error(`run-pg-112-tests: failed: ${notOk.join(' | ')}`); bad = true; }
if (missing.length) { console.error(`run-pg-112-tests: missing: ${missing.join(' | ')}`); bad = true; }
if (extra.length) { console.error(`run-pg-112-tests: extra: ${extra.join(' | ')}`); bad = true; }
writeSync(1, `run-pg-112-tests: ${leafOk.size}/${expected.size} pinned tests passed, exit ${r.status}, ${bad ? 'FAIL' : 'OK'}\n`);
process.exitCode = bad ? 1 : 0;
