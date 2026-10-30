/**
 * S245-S2 (#245 ACCEPT soft-pack): pin the wake.kind === 'task' → 'run-task-wake' seam.
 *
 * S243-S2 (#243) made Run Task wakes carry `chatTaskTools: 'run-task-wake'` (NOT boolean true)
 * so addMyTask gets the wake-aware copy — during a task wake the agent EXECUTES the queued work
 * instead of re-queueing it via addMyTask (the S243-S2 self-re-queue trap). The behavioural
 * assembly pin lives in packages/mastra/src/tools/chat-task-tools.test.ts; what nothing pinned
 * was the WIRE between the scheduler and that assembly (gate survivors M12/M13):
 *
 *  - either wake-runner call site (harness + durable) reverting `wake.kind === 'task'` to
 *    boolean `true` silently hands the CHAT copy of addMyTask to a task wake — every mastra
 *    pin still passes because assembleAgentTools only ever sees `true`;
 *  - harness-adapter "tidying" the pass-through with `Boolean(options.chatTaskTools)` collapses
 *    'run-task-wake' to true one hop before the seam, with the same silent effect.
 *
 * Source pins (repo convention — see task-runner-208-softs.test.ts; node:test mock.module is
 * off the table without --experimental-test-module-mocks): mutants boolean-revert and
 * Boolean-coerce both land RED here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WAKE_RUNNER_SRC = readFileSync(path.join(__dirname, 'wake-runner.ts'), 'utf8');
const ADAPTER_SRC = readFileSync(path.join(__dirname, 'adapters', 'harness-adapter.ts'), 'utf8');

/** The canonical task-wake value expression (both wake-runner call sites). */
const TASK_WAKE_VALUE = String.raw`wake\.kind === 'task'\s*\?\s*\(\s*'run-task-wake'\s+as const\s*\)\s*:\s*false`;

describe('S245-S2: wake-runner feeds chatTaskTools the wake-aware string, not a boolean', () => {
  it('BOTH task-wake call sites (harness + durable) pass (wake.kind === "task" ? "run-task-wake" : false)', () => {
    const sites = WAKE_RUNNER_SRC.match(new RegExp(`chatTaskTools:\\s*(?:params\\.)?${TASK_WAKE_VALUE}`, 'g')) ?? [];
    assert.equal(
      sites.length,
      2,
      'exactly two chatTaskTools assignments are expected — the runWithHarness (harness) and ' +
        'createDurableAgentWithSkills (durable) task-wake call sites; a revert, rename or drop REDs here',
    );
  });

  it('the harness path feeds the string INSIDE the runWithHarness options', () => {
    // Scope to the harness invocation so a durable-only assignment cannot satisfy the pin.
    const call = WAKE_RUNNER_SRC.slice(WAKE_RUNNER_SRC.indexOf('runWithHarness('));
    const harnessBlock = call.slice(0, call.indexOf('logIssueStateAfterRun'));
    assert.match(
      harnessBlock,
      new RegExp(`chatTaskTools:\\s*${TASK_WAKE_VALUE}`),
      'runWithHarness must receive (wake.kind === "task" ? "run-task-wake" : false) — boolean ' +
        'true here hands the chat copy of addMyTask to a task wake (S243-S2 trap reopens)',
    );
  });

  it('the durable path feeds the string INSIDE the createDurableAgentWithSkills options', () => {
    const call = WAKE_RUNNER_SRC.slice(WAKE_RUNNER_SRC.indexOf('createDurableAgentWithSkills('));
    const durableBlock = call.slice(0, call.indexOf('createHeartbeatRuntimeContext'));
    assert.match(
      durableBlock,
      new RegExp(`chatTaskTools:\\s*params\\.${TASK_WAKE_VALUE}`),
      'the durable wake must pass the literal string too — one call site collapsing to true ' +
        'silently re-arms the re-queue loop for non-harness agents only',
    );
  });

  it('no call site ever collapses the value to boolean true', () => {
    // The exact mutant the pin exists for: `wake.kind === 'task' ? true : false` (the
    // pre-#243 boolean wire) must never return — semantically it selects the chat copy.
    assert.doesNotMatch(
      WAKE_RUNNER_SRC,
      /chatTaskTools:\s*(?:params\.)?wake\.kind === 'task'\s*\?\s*true/,
      'boolean true at a task-wake chatTaskTools site loses the wake-aware addMyTask selection',
    );
    // And no site may coerce through Boolean() before the seam (would fold 'run-task-wake' to true).
    assert.doesNotMatch(WAKE_RUNNER_SRC, /chatTaskTools:\s*Boolean\(/);
  });
});

describe('S245-S2: harness-adapter passes chatTaskTools through unchanged', () => {
  it('forwards options.chatTaskTools to createTourbillonController verbatim (?? false only)', () => {
    // S249-S1 (#249): end-anchored. The old prefix-only /…?? false/ stayed GREEN when a ternary
    // was glued after the default (`?? false ? true : false`) — which folds 'run-task-wake' to
    // boolean true and re-arms the S243-S2 re-queue trap while every pin above stayed green.
    // The pass-through must END at the default: a `,`/`;` to end the object property, nothing else.
    assert.match(
      ADAPTER_SRC,
      /chatTaskTools:\s*options\.chatTaskTools\s*\?\?\s*false\s*[,;]\s*$/m,
      'the adapter may only default the value (?? false); any transform in between is where ' +
        "'run-task-wake' would silently die before reaching assembleAgentTools",
    );
    // Belt for the exact mutant shape: nothing may dangle after the default — no ternary `?`,
    // no Boolean()/!! coercion glued on the tail of the pass-through.
    assert.doesNotMatch(
      ADAPTER_SRC,
      /chatTaskTools:\s*options\.chatTaskTools\s*\?\?\s*false\s*(?:\?|Boolean\(|!!)/,
      '`options.chatTaskTools ?? false ? …` turns every run-task-wake into boolean true — ' +
        'the end-anchor exists precisely so this mutant cannot hide behind the prefix match',
    );
  });

  it('never Boolean()-coerces the value on the way through', () => {
    assert.doesNotMatch(
      ADAPTER_SRC,
      /Boolean\(\s*options\.chatTaskTools\s*\)/,
      'Boolean(options.chatTaskTools) folds the "run-task-wake" string to true — the exact ' +
        'M13 mutant this pin must catch',
    );
  });

  it('keeps the union type that carries the string across the package boundary', () => {
    // A narrowing back to `boolean` would make the string a type error upstream — but pin it
    // here too so the RED names this seam instead of surfacing as a tsc error only.
    assert.match(ADAPTER_SRC, /chatTaskTools\?:\s*boolean \| 'run-task-wake'/);
  });
});
