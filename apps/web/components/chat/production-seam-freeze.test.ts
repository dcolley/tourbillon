/**
 * S321-S1 (Refs #301): pin the S309-S4 prod freeze on the two chat test seams.
 *
 * `components/chat/agent-chat-pane.tsx` and `components/assistant/agent-chat.tsx` both ship a
 * `__test__` seam object (stub points for the DOM-level pane test and the assistant header test)
 * and freeze it under NODE_ENV=production so a stray render path cannot swap the stubs inside
 * the shipped client bundle (positive 'production' check: Next replaces process.env.NODE_ENV
 * statically, and the tsx node:test runner - which mutates the seam - never runs with
 * NODE_ENV=production). Nothing pinned either freeze: deleting `Object.freeze(__test__)` from
 * either module kept the whole suite green (S321-S1).
 *
 * Each module is imported by a CHILD process (plain node --import tsx) under a chosen
 * NODE_ENV - the freeze is module-eval-time env, so a child is the only way to observe both
 * sides. Pins: FROZEN under production; NOT frozen under test (and development - so the check
 * cannot be re-written into "freeze unless NODE_ENV is test", which would break the seam under
 * the runner). Mutant: remove either freeze -> the production probe goes RED.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODULES: Array<{ name: string; path: string; seamKeys: string[] }> = [
  {
    name: 'chat pane (agent-chat-pane.tsx)',
    path: fileURLToPath(new URL('./agent-chat-pane.tsx', import.meta.url)),
    seamKeys: ['ChatPaneBody', 'useChatSendKeyMode', 'ChatSendKeyMenu'],
  },
  {
    name: 'assistant container (agent-chat.tsx)',
    path: fileURLToPath(new URL('../assistant/agent-chat.tsx', import.meta.url)),
    seamKeys: ['useAgentChat', 'useChatSendKeyMode'],
  },
];

interface ProbeResult {
  frozen: boolean;
  hasTest: boolean;
  seamKeys: string[];
  modKeys?: string[];
}

/** Import the module in a child tsx process under NODE_ENV=`envValue` and report the seam state. */
function probeSeam(modulePath: string, envValue: 'production' | 'test' | 'development'): ProbeResult {
  // Interop-hardened probe: under full-suite load, `import()` of the tsx-compiled module can
  // come back with a CJS namespace that exposes only `default` (named-export detection race),
  // so read __test__ from m or m.default — the PIN is about the seam OBJECT's frozen state,
  // which is identical under either namespace shape.
  const code =
    `import(${JSON.stringify(modulePath)}).then((m) => {` +
    `  const mod = m && m.__test__ === undefined && m.default !== undefined ? m.default : m;` +
    `  const t = mod ? mod.__test__ ?? null : null;` +
    `  console.log('PROBE' + JSON.stringify({` +
    `    frozen: t !== null && Object.isFrozen(t),` +
    `    hasTest: t !== null,` +
    `    seamKeys: t === null ? [] : Object.keys(t),` +
    `    modKeys: Object.keys(m).slice(0, 12),` +
    `  }));` +
    `}, (e) => { console.log('PROBE_ERR' + String(e && e.stack || e)); process.exit(2); });`;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '-e', code], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), // apps/web: resolves the tsx loader + '@/..' imports
    env: { ...process.env, NODE_ENV: envValue },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('PROBE'));
  assert.equal(
    run.status === 0 && line !== undefined,
    true,
    `probe of ${modulePath} under NODE_ENV=${envValue} produced a PROBE line (status=${run.status}; stdout=${(run.stdout ?? '').slice(0, 300)}; stderr=${(run.stderr ?? '').slice(0, 500)})`,
  );
  assert.ok(line && line.startsWith('PROBE{'), `probe reported JSON, got: ${String(line)}`);
  return JSON.parse(line!.slice('PROBE'.length)) as ProbeResult;
}

describe('S321-S1: __test__ seams are frozen in production and mutable for tests', () => {
  for (const { name, path, seamKeys } of MODULES) {
    it(`${name}: __test__ is FROZEN under NODE_ENV=production`, () => {
      const probe = probeSeam(path, 'production');
      assert.equal(probe.hasTest, true, `the module exports the __test__ seam (probe=${JSON.stringify(probe)})`);
      assert.deepEqual(probe.seamKeys.slice().sort(), seamKeys.slice().sort(), 'the seam holds the expected stub points');
      assert.equal(probe.frozen, true, 'Object.freeze(__test__) runs when NODE_ENV=production (S309-S4)');
    });

    it(`${name}: __test__ is NOT frozen under NODE_ENV=test`, () => {
      const probe = probeSeam(path, 'test');
      assert.equal(probe.hasTest, true, 'the module exports the __test__ seam');
      assert.equal(probe.frozen, false, 'the seam stays swappable under the test env (tests mutate it)');
    });

    it(`${name}: __test__ is NOT frozen under NODE_ENV=development`, () => {
      // Pins the POSITIVE 'production' check: a rewrite to `!== 'test'` (or !development)
      // would freeze Fast Refresh's re-evaluated seam and/or break test stubbing.
      const probe = probeSeam(path, 'development');
      assert.equal(probe.hasTest, true, 'the module exports the __test__ seam');
      assert.equal(probe.frozen, false, 'the seam stays mutable under development (positive-check idiom, S309-S4)');
    });
  }
});
