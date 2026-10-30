#!/usr/bin/env node
/**
 * packages/mastra authoritative test counter (S264-S3, Refs #264; S268-S3 fixes, Refs #268).
 *
 * Why this exists:
 *   Running the suite with `--test-force-exit` makes Node's test reporter end
 *   the run before every test result has been collected. What actually
 *   reproduces (2026-10-30 gate run, same tree, full serial suite):
 *     no force-exit : # tests 409 / pass 400 / fail 1 / skipped 8   (stable,
 *                     exits on its own in ~70s - no lingering handles today)
 *     force-exit #1 : # tests 379 / pass 370 / fail 1 / skipped 8   <- 30 tests
 *                     silently MISSING from a COMPLETE-LOOKING summary, exit 0
 *     force-exit #2 : # tests 409 / pass 400 / fail 1 / skipped 8   <- complete, by luck
 *   The summary is NOT truncated mid-block - it parses, every `# <key>` line
 *   is present, and the numbers add up; whole tests are simply absent. That
 *   is why the missing-keys / add-up guards below CANNOT catch force-exit
 *   drift: the only defence is never force-exiting, which this script
 *   encodes (and pins - see src/scripts/run-tests.test.ts, S268-S3c).
 *   This is the likely root cause of the suite-count drift flagged by the
 *   #260 / #262 / #264 test gates (S260-S4 / S262-S4 / S264-S3).
 *
 * Rules this encodes:
 *   - NEVER gate the mastra suite on a --test-force-exit run: it is not
 *     needed (the suite exits cleanly) and its counts are unreliable.
 *   - Counts are only reported when the TAP summary block is complete; a
 *     missing/incomplete summary exits non-zero with "COUNTS INCOMPLETE"
 *     instead of printing numbers that could be silently short.
 *
 * S268-S3 (Refs #268) runner fixes:
 *   (a) A test file that calls process.exit(0) mid-run used to be counted as
 *       ONE passing test and reported COUNTS COMPLETE. Such a file now
 *       shows up as a file-level `ok` result with zero test rows and is
 *       reported COUNTS INCOMPLETE (exit 1), naming the file - an early
 *       exit is a failure of the run, not a pass.
 *   (b) On timeout the old spawnSync path left result.error set, so the run
 *       was reported as "runner failed to start" while the hung test process
 *       could survive the kill as an orphan. The suite now runs in its own
 *       process group; on timeout the whole group is SIGKILLed and the
 *       report says "timed out".
 *   (c) The docstring previously claimed force-exit truncates the summary;
 *       the observed failure is a complete-looking summary with fewer tests.
 *       Corrected above.
 *
 * Usage:
 *   pnpm --filter @tourbillon/mastra test:counts
 *   pnpm --filter @tourbillon/mastra test:counts -- src/tools/role-tools.test.ts
 *   MASTRA_TEST_TIMEOUT_MS=600000 pnpm --filter @tourbillon/mastra test:counts
 */
import { readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SUFFIX = '.test.ts';
const TEST_DIRS = ['src'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(SUFFIX)) out.push(relative(PKG_ROOT, full));
  }
  return out;
}

// Explicit file list, same rationale as apps/web/scripts/run-tests.mjs:
// glob expansion differs across the Node versions engines allows (>=20).
const extra = process.argv.slice(2);
const targets = extra.length > 0 ? extra : TEST_DIRS.flatMap((d) => walk(join(PKG_ROOT, d))).sort();
if (targets.length === 0) {
  console.error('no test files found');
  process.exit(1);
}

const tsx = join(PKG_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const timeoutMs = Number(process.env.MASTRA_TEST_TIMEOUT_MS ?? 15 * 60_000);

// S268-S3(b): spawn (not spawnSync) in a dedicated process group so a
// timeout can SIGKILL the ENTIRE tree. The test files run as grandchildren
// (this script -> tsx -> node <file>.test.ts); killing only the direct child
// left hung grandchildren orphaned on the #264 gate box.
const childEnv = { ...process.env };
// When the runner itself is invoked from inside a node:test tree (e.g. the
// S268-S3 e2e tests), the child inherits NODE_TEST_CONTEXT and the inner
// node:test refuses to run() files ("recursively within a test file").
// The spawned suite is a FRESH run, not a nested one - clear the marker.
delete childEnv.NODE_TEST_CONTEXT;
const child = spawn(
  existsSync(tsx) ? tsx : 'tsx',
  ['--conditions=tourbillon-test', '--test', '--test-reporter=tap', ...targets],
  {
    cwd: PKG_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
    env: childEnv,
  },
);

let timedOut = false;
let spawnError = null;
let stdout = '';
let stderr = '';
child.stdout?.on('data', (d) => { stdout += d.toString(); });
child.stderr?.on('data', (d) => { stderr += d.toString(); });
child.on('error', (err) => { spawnError = err; });

const timer = setTimeout(() => {
  timedOut = true;
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGKILL'); // whole process group
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // Group already gone - the close event below decides the report.
  }
}, timeoutMs);

const close = await new Promise((resolve) => {
  let settled = false;
  const done = (code, signal) => {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal });
    }
  };
  child.on('error', () => done(null, null));
  child.on('close', (code, signal) => done(code, signal));
});

const out = `${stdout}${stderr}`;
process.stdout.write(out);

if (spawnError) {
  console.error(`COUNTS INCOMPLETE: runner failed to start: ${spawnError.message}`);
  process.exit(1);
}
if (timedOut) {
  console.error(
    `COUNTS INCOMPLETE: runner timed out after ${timeoutMs}ms - a test is hanging; ` +
      `the whole test process group was SIGKILLed${child.pid ? ` (pgid -${child.pid})` : ''}. ` +
      'The counts above, if any, are NOT authoritative.',
  );
  process.exit(1);
}
if (close.signal || close.code === null) {
  console.error(
    `COUNTS INCOMPLETE: runner killed (${close.signal ?? 'no status'}) - ` +
      'a test is hanging; the counts above, if any, are NOT authoritative.',
  );
  process.exit(1);
}

// Last TAP summary block wins (each subtest prints its own fragments).
const summary = {};
const wanted = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
for (const line of out.split('\n')) {
  const m = line.match(/^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/);
  if (m) summary[m[1]] = Number(m[2]);
}
const missing = wanted.filter((k) => !(k in summary));
if (missing.length > 0) {
  console.error(`COUNTS INCOMPLETE: TAP summary missing ${missing.join(', ')} - do NOT trust these counts.`);
  process.exit(1);
}
if (summary.pass + summary.fail + summary.cancelled + summary.skipped + summary.todo < summary.tests) {
  console.error('COUNTS INCOMPLETE: summary lines do not add up - do NOT trust these counts.');
  process.exit(1);
}
if (summary.cancelled > 0) {
  console.error(
    `COUNTS INCOMPLETE: ${summary.cancelled} test(s) cancelled - the run was interrupted ` +
      'before every test produced a verdict; do NOT trust these counts.',
  );
  process.exit(1);
}

// S268-S3(a): a file that process.exit()s mid-run never prints test rows -
// Node reports the FILE as a single passing top-level test, which the old
// guards happily counted as COUNTS COMPLETE (P2 in the #268 gate comment:
// tests=1, exit 0). A top-level result whose name is a test file and which
// contains zero nested test rows is a collapse, not a pass.
function findCollapsedFiles(tap) {
  const collapsed = [];
  let open = null;
  for (const line of tap.split('\n')) {
    if (line.startsWith('# Subtest: ')) {
      open = { name: line.slice('# Subtest: '.length).trim(), children: 0 };
      continue;
    }
    if (/^\s/.test(line)) {
      if (open && /^\s+(ok|not ok) \d+ - /.test(line)) open.children += 1;
      continue;
    }
    const m = line.match(/^(ok|not ok) \d+ - (.*?)(?: #.*)?$/);
    if (m && open && m[2] === open.name) {
      if (m[1] === 'ok' && !/#\s*(SKIP|TODO)/i.test(line) && m[2].endsWith(SUFFIX) && open.children === 0) {
        collapsed.push(m[2]);
      }
      open = null;
    }
  }
  return collapsed;
}

const collapsedFiles = findCollapsedFiles(out);
if (collapsedFiles.length > 0) {
  console.error(
    `COUNTS INCOMPLETE: ${collapsedFiles.length} test file(s) reported a file-level pass with ` +
      `zero test results - the file exited early (process.exit?) and Node counted it as one ` +
      `fake pass: ${collapsedFiles.join(', ')}. Do NOT trust these counts.`,
  );
  process.exit(1);
}

console.error(
  `COUNTS COMPLETE: tests=${summary.tests} pass=${summary.pass} fail=${summary.fail} ` +
    `skipped=${summary.skipped} cancelled=${summary.cancelled} todo=${summary.todo}`,
);
process.exit(close.code ?? 0);
