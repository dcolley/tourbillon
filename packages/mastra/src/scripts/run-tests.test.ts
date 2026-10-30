import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// S268-S3 (Refs #268): scripts/run-tests.mjs gaps, each pinned end-to-end
// against a spawned runner + fixture test file (the runner spawns tsx itself,
// so these are the only honest way to exercise its guards):
//   (a) a file that process.exit()s mid-run must NOT count as one pass;
//   (b) a hung run must be reported as a timeout (not "failed to start")
//       and the whole process tree must die with it;
//   (c) the docstring must describe force-exit the way it really fails
//       (a complete-looking summary with fewer tests) - pinned by source.

const PKG_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RUNNER = join(PKG_ROOT, 'scripts', 'run-tests.mjs');

type RunnerResult = { status: number | null; signal: string | null; out: string };

function runRunner(args: string[], extraEnv: Record<string, string> = {}, spawnTimeoutMs = 120_000): RunnerResult {
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
  // The outer tsx --test harness must not leak loader flags into the inner
  // runner (the #264 gate runs also ran with NODE_PATH deliberately unset).
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const r = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
    env,
    timeout: spawnTimeoutMs,
  });
  return { status: r.status, signal: r.signal, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function fixturesDir(): string {
  return mkdtempSync(join(tmpdir(), 's268-s3-'));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe('run-tests.mjs S268-S3 guards', () => {
  it('a healthy fixture still reports COUNTS COMPLETE and exits 0 (guard must not eat real runs)', () => {
    const dir = fixturesDir();
    const file = join(dir, 'healthy.test.ts');
    writeFileSync(
      file,
      "import { test } from 'node:test';\ntest('alpha', () => {});\ntest('beta', () => {});\n",
    );
    const r = runRunner([file]);
    assert.equal(r.status, 0, `expected exit 0:\n${r.out}`);
    assert.match(r.out, /COUNTS COMPLETE: tests=2 pass=2/);
  });

  it('(a) a file that process.exit()s mid-run is NOT counted as one pass', () => {
    const dir = fixturesDir();
    const file = join(dir, 'early-exit.test.ts');
    writeFileSync(
      file,
      "import { test } from 'node:test';\n" +
        "test('first', () => {});\n" +
        'test(\'exits\', () => { process.exit(0); });\n' +
        "test('never-runs', () => { throw new Error('must not run'); });\n",
    );
    const r = runRunner([file]);
    // Pre-fix (P2 in the #268 gate comment) this exited 0 with
    // "COUNTS COMPLETE: tests=1 pass=1" - the collapsed file counted as a
    // single fake pass.
    assert.notEqual(r.status, 0, `early exit must not exit 0:\n${r.out}`);
    assert.doesNotMatch(r.out, /COUNTS COMPLETE/);
    assert.match(r.out, /COUNTS INCOMPLETE/);
    assert.match(r.out, /zero test results/);
    assert.match(r.out, /early-exit\.test\.ts/, 'the collapsing file is named in the report');
  });

  it('(b) a hung run reports a timeout (not "failed to start") and the process tree dies', () => {
    const dir = fixturesDir();
    const pidFile = join(dir, 'grandchild.pid');
    const file = join(dir, 'hangs.test.ts');
    writeFileSync(
      file,
      "import { test } from 'node:test';\n" +
        "import { writeFileSync } from 'node:fs';\n" +
        "import { spawn } from 'node:child_process';\n" +
        "test('hangs', () => {\n" +
        '  // A real grandchild of the runner (runner -> tsx -> node file -> sleep).\n' +
        '  // Killing only the direct child (mutant) orphans THIS one; a process-\n' +
        '  // group kill takes it down with the tree.\n' +
        '  const sleeper = spawn("sleep", ["300"], { stdio: "ignore" });\n' +
        '  sleeper.unref();\n' +
        '  if (process.env.S268_GRANDCHILD_PID_FILE) writeFileSync(process.env.S268_GRANDCHILD_PID_FILE, String(sleeper.pid));\n' +
        '  // Keep the event loop alive so node:test cannot self-cancel the\n' +
        '  // pending test when handles drain - this must hang until the\n' +
        '  // runner times out and SIGKILLs the process group.\n' +
        '  setInterval(() => {}, 1000);\n' +
        '  return new Promise(() => {});\n' +
        '});\n',
    );
    const r = runRunner([file], {
      MASTRA_TEST_TIMEOUT_MS: '4000',
      S268_GRANDCHILD_PID_FILE: pidFile,
    });
    assert.notEqual(r.status, 0, `hung run must not exit 0:\n${r.out}`);
    assert.doesNotMatch(r.out, /COUNTS COMPLETE/);
    assert.match(r.out, /COUNTS INCOMPLETE/);
    assert.match(r.out, /timed out/i, 'must be reported as a timeout');
    assert.doesNotMatch(r.out, /failed to start/, 'a timeout is not a failed start (old spawnSync ETIMEDOUT mislabel)');

    // The hung run owns a descendant tree (runner -> tsx -> node file ->
    // sleep). Killing only the direct child orphans the deep descendants;
    // they must not survive the runner timeout.
    assert.ok(existsSync(pidFile), 'fixture must have recorded its pid');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0);
    const deadline = Date.now() + 5_000;
    while (pidAlive(pid) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    assert.ok(!pidAlive(pid), `descendant process ${pid} survived the runner timeout (orphaned)`);
  });

  it('(c) docstring tells the truth about force-exit; runner never force-exits', () => {
    const src = readFileSync(RUNNER, 'utf8');
    // Observed failure mode: a COMPLETE-LOOKING summary with fewer tests.
    assert.match(src, /complete-looking/, 'docstring must describe the observed force-exit failure');
    // The old wrong claim (truncated summary) must be gone.
    assert.doesNotMatch(src, /truncate the trailing TAP summary/);
    // The runner must never spawn with force-exit at all (the docstring may
    // NAME the flag in backticks; a quoted CLI arg would use it).
    assert.doesNotMatch(src, /['"]--test-force-exit['"]/, 'runner must never pass --test-force-exit');
    // And the spawn args are pinned exactly:
    assert.match(src, /\['--conditions=tourbillon-test', '--test', '--test-reporter=tap'/);
    // Honest reporting split: timeout vs failed-to-start are distinct paths.
    assert.match(src, /COUNTS INCOMPLETE: runner timed out/);
    assert.match(src, /COUNTS INCOMPLETE: runner failed to start/);
    // S268-S3b: the spawnSync path is gone (docstring may NAME it in prose;
    // an import or call must not survive).
    assert.doesNotMatch(src, /import\s*\{[^}]*\bspawnSync\b/, 'S268-S3b: spawnSync import is gone');
    assert.doesNotMatch(src, /\bspawnSync\s*\(/, 'S268-S3b: the spawnSync path (dead signal branch, orphan tree) is gone');
    assert.match(src, /process\.kill\(-child\.pid, 'SIGKILL'\)/, 'timeouts kill the process GROUP');
  });
});
