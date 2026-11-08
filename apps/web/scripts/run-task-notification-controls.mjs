#!/usr/bin/env node
/**
 * Execute TN_CONTROL mutants one at a time.
 * Each entry must (1) pass its target cell unmutated with exit 0 and
 * (2) kill that cell with a natural nonzero exit (not SIGTERM 143).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));

// C-PIN-RESTORE is excluded under the no-switch H3 design.
const KILLS = [
  { control: 'C-SCOPE-LOOKUP', cell: 'TN-ORIGIN-LOOKUP-COMPANY-SCOPE' },
  { control: 'C-HIJACK', cell: 'TN-DEFAULT-PATH' },
  { control: 'C-SHARED-IDENTITY', cell: 'TN-CONCURRENT-AGENT-COMPANY' },
  { control: 'C-PUB', cell: 'TN-IDLE-DONE' },
  { control: 'C-DEDUPE', cell: 'TN-ONCE-DUP' },
  { control: 'C-PERSIST', cell: 'TN-IDLE-DONE' },
  { control: 'C-THREAD', cell: 'TN-WRONG-THREAD-LIVE' },
  { control: 'C-WRONG-THREAD-DEFAULT', cell: 'TN-WRONG-THREAD-LIVE' },
  { control: 'C-BUSY-OTHER-DROP', cell: 'TN-BUSY-UNRELATED-PIN' },
  { control: 'C-ACK', cell: 'TN-IDLE-DONE' },
];

if (process.env.TN_DISPOSABLE !== '1') {
  console.error('run-task-notification-controls: TN_DISPOSABLE=1 is required');
  process.exit(1);
}

function runCell(cell, envExtra = {}) {
  const env = {
    ...process.env,
    TN_CONTROL_WAIT_MS: process.env.TN_CONTROL_WAIT_MS || '4000',
    ...envExtra,
  };
  if (!env.TN_CONTROL) delete env.TN_CONTROL;
  return spawnSync(
    'pnpm',
    [
      'exec',
      'tsx',
      '--test',
      '--test-concurrency=1',
      '--test-reporter=tap',
      `--test-name-pattern=^(TN-PROVENANCE-PREFLIGHT|${cell})$`,
      'lib/assistant/task-notification-boundary.test.ts',
    ],
    {
      cwd: WEB_ROOT,
      encoding: 'utf8',
      timeout: 90_000,
      env,
    },
  );
}

function tapKilled(output, cell) {
  return new RegExp(`not ok \\d+ - ${cell}\\b`).test(output);
}

function tapPassed(output, cell) {
  return new RegExp(`^ok \\d+ - ${cell}\\b`, 'm').test(output) && !tapKilled(output, cell);
}

const rows = [];
const failures = [];
const unmutatedCache = new Map();

for (const { control, cell } of KILLS) {
  if (!unmutatedCache.has(cell)) {
    console.log(`\n=== unmutated baseline must pass ${cell} ===`);
    const result = runCell(cell);
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const ok = result.status === 0 && result.signal == null && tapPassed(output, cell);
    unmutatedCache.set(cell, { ok, status: result.status, signal: result.signal });
    if (!ok) {
      failures.push(
        `unmutated/${cell}: expected natural exit 0 (status=${result.status} signal=${result.signal})`,
      );
    } else {
      console.log(`ok: unmutated ${cell} passed with exit 0`);
    }
  }

  console.log(`\n=== control ${control} must kill ${cell} ===`);
  const result = runCell(cell, { TN_CONTROL: control });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const status = result.status;
  const signal = result.signal;
  const killed = tapKilled(output, cell);
  const natural = status !== 0 && status !== 143 && signal == null && killed;
  const unmutated = unmutatedCache.get(cell);
  rows.push({
    control,
    cell,
    unmutated: unmutated?.ok ? 'PASS exit 0' : `FAIL status=${unmutated?.status} signal=${unmutated?.signal}`,
    mutated: natural ? `KILLED exit ${status}` : `FAIL status=${status} signal=${signal} tapNotOk=${killed}`,
    natural: natural && !!unmutated?.ok,
  });
  if (!natural) {
    failures.push(`${control}/${cell}: expected natural nonzero kill (status=${status} signal=${signal} tapNotOk=${killed})`);
    continue;
  }
  console.log(`ok: ${control} killed ${cell} with natural exit ${status}`);
}

const outDir = process.env.TN_EVIDENCE_DIR || '/tmp/tb-notify-impl/evidence/phase2-m1';
mkdirSync(outDir, { recursive: true });
const md = [
  '# M1 control kills',
  '',
  `Generated ${new Date().toISOString()}`,
  '',
  '| Control | Target cell | Unmutated | Mutated | Natural pair |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.control} | ${r.cell} | ${r.unmutated} | ${r.mutated} | ${r.natural ? 'yes' : 'no'} |`),
  '',
  failures.length
    ? `Failures:\n${failures.map((f) => `- ${f}`).join('\n')}`
    : `All ${rows.length} listed controls killed their target with a natural nonzero exit, and each target passed unmutated.`,
  '',
].join('\n');
writeFileSync(join(outDir, 'kills.md'), md);
console.log(`\nwrote ${join(outDir, 'kills.md')}`);

if (failures.length) {
  console.error('TN-CONTROL failures:\n' + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
const killed = rows.filter((r) => r.natural).length;
console.log(`TN-CONTROL: ${killed}/${rows.length} mutants killed naturally; ${unmutatedCache.size} unmutated baselines passed`);
process.exit(0);
