#!/usr/bin/env node
/**
 * Execute TN_CONTROL mutants one at a time.
 * expect:'kill' — unmutated exit 0 + mutated natural nonzero with TAP not-ok.
 * expect:'pass' — same mutant must leave the cell GREEN (idle side of a split).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));

// C-PIN-RESTORE is excluded under the no-switch H3 design.
const KILLS = [
  { control: 'C-SCOPE-LOOKUP', cell: 'TN-ORIGIN-LOOKUP-COMPANY-SCOPE', expect: 'kill' },
  { control: 'C-HIJACK', cell: 'TN-DEFAULT-PATH', expect: 'kill' },
  { control: 'C-SHARED-IDENTITY', cell: 'TN-CONCURRENT-AGENT-COMPANY', expect: 'kill' },
  { control: 'C-SHARED-CTRL', cell: 'TN-CONCURRENT-AGENT-COMPANY', expect: 'kill' },
  { control: 'C-PUB', cell: 'TN-IDLE-DONE', expect: 'kill' },
  { control: 'C-DEDUPE', cell: 'TN-ONCE-DUP', expect: 'kill' },
  { control: 'C-PERSIST', cell: 'TN-IDLE-DONE', expect: 'kill' },
  { control: 'C-THREAD', cell: 'TN-WRONG-THREAD-LIVE', expect: 'kill' },
  { control: 'C-WRONG-THREAD-DEFAULT', cell: 'TN-WRONG-THREAD-LIVE', expect: 'kill' },
  { control: 'C-PIN-FOLLOW', cell: 'TN-WRONG-THREAD-LIVE', expect: 'kill' },
  { control: 'C-ACK', cell: 'TN-IDLE-DONE', expect: 'kill' },
  { control: 'C-DRESS-ASK', cell: 'TN-IDLE-FAIL', expect: 'kill' },
  { control: 'C-FALSE-RUN', cell: 'TN-IDLE-DONE', expect: 'kill' },
  { control: 'C-BRIDGE', cell: 'TN-IDLE-DONE', expect: 'kill' },
  { control: 'C-BRIDGE', cell: 'TN-BUSY-UNRELATED-PIN', expect: 'kill' },
  { control: 'C-WAKE', cell: 'TN-IDLE-DONE', expect: 'kill' },
  { control: 'C-WAKE', cell: 'TN-BUSY-UNRELATED-PIN', expect: 'kill' },
  { control: 'C-SETTLE', cell: 'TN-BUSY-ORIGIN-HELD', expect: 'kill' },
  { control: 'C-BUSY-OTHER-DROP', cell: 'TN-IDLE-DONE', expect: 'pass' },
  { control: 'C-BUSY-OTHER-DROP', cell: 'TN-BUSY-UNRELATED-PIN', expect: 'kill' },
];

if (process.env.TN_DISPOSABLE !== '1') {
  console.error('run-task-notification-controls: TN_DISPOSABLE=1 is required');
  process.exit(1);
}

const outDir = process.env.TN_EVIDENCE_DIR || join(WEB_ROOT, '.tn-controls-evidence');
const logDir = join(outDir, 'logs');
mkdirSync(logDir, { recursive: true });

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
      timeout: 150_000,
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
function slug(control, cell, kind) {
  return `${control}__${cell}__${kind}.log`;
}

const rows = [];
const failures = [];
const unmutatedCache = new Map();

for (const { control, cell, expect } of KILLS) {
  if (!unmutatedCache.has(cell)) {
    console.log(`\n=== unmutated baseline must pass ${cell} ===`);
    const result = runCell(cell);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    writeFileSync(join(logDir, slug('UNMUTATED', cell, 'pass')), output);
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    const ok = result.status === 0 && result.signal == null && tapPassed(output, cell);
    unmutatedCache.set(cell, { ok, status: result.status, signal: result.signal });
    if (!ok) {
      failures.push(`unmutated/${cell}: expected natural exit 0 (status=${result.status} signal=${result.signal})`);
    } else {
      console.log(`ok: unmutated ${cell} passed with exit 0`);
    }
  }

  console.log(`\n=== control ${control} expect=${expect} on ${cell} ===`);
  const result = runCell(cell, { TN_CONTROL: control });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  writeFileSync(join(logDir, slug(control, cell, expect)), output);
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  const status = result.status;
  const signal = result.signal;
  const killed = tapKilled(output, cell);
  const passed = tapPassed(output, cell);
  const unmutated = unmutatedCache.get(cell);
  let ok = false;
  let mutatedLabel = '';
  if (expect === 'kill') {
    ok = status !== 0 && status !== 143 && signal == null && killed;
    mutatedLabel = ok ? `KILLED exit ${status}` : `FAIL status=${status} signal=${signal} tapNotOk=${killed}`;
    if (!ok) failures.push(`${control}/${cell}: expected natural nonzero kill (status=${status} signal=${signal} tapNotOk=${killed})`);
    else console.log(`ok: ${control} killed ${cell} with natural exit ${status}`);
  } else {
    ok = status === 0 && signal == null && passed;
    mutatedLabel = ok ? `PASS exit 0 (idle split)` : `FAIL status=${status} signal=${signal} tapOk=${passed}`;
    if (!ok) failures.push(`${control}/${cell}: expected idle-split PASS (status=${status} signal=${signal})`);
    else console.log(`ok: ${control} left ${cell} GREEN (idle split)`);
  }
  rows.push({
    control,
    cell,
    expect,
    unmutated: unmutated?.ok ? 'PASS exit 0' : `FAIL status=${unmutated?.status} signal=${unmutated?.signal}`,
    mutated: mutatedLabel,
    natural: ok && !!unmutated?.ok,
  });
}

const md = [
  '# M1 remaining control kills',
  '',
  `Generated ${new Date().toISOString()}`,
  '',
  '| Control | Target cell | Expect | Unmutated | Mutated | Natural pair |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.control} | ${r.cell} | ${r.expect} | ${r.unmutated} | ${r.mutated} | ${r.natural ? 'yes' : 'no'} |`),
  '',
  failures.length
    ? `Failures:\n${failures.map((f) => `- ${f}`).join('\n')}`
    : `All ${rows.length} remaining executions matched the contract (kills or idle-split pass).`,
  '',
].join('\n');
writeFileSync(join(outDir, 'kills-remaining.md'), md);
console.log(`\nwrote ${join(outDir, 'kills-remaining.md')}`);

if (failures.length) {
  console.error('TN-CONTROL failures:\n' + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log(`TN-CONTROL: ${rows.filter((r) => r.natural).length}/${rows.length} remaining executions matched`);
process.exit(0);
