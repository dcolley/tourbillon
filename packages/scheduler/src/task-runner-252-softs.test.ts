/**
 * S252-S1 + S252-S2 (#252 ACCEPT soft-pack, info/harden): honesty pins around the cap-0
 * remedy copy and env-independence of the paused-skip poll test.
 *
 * S252-S1: the cap-0 refusal copy names two remedies — raise TASK_RUNNER_MAX_CONCURRENT_RUNS
 * to ≥ 2, or pass an explicit opts.taskCap ≥ 1. They are NOT equally reachable. The env half
 * is the ONLY knob the scheduler-main boot path can turn: main calls
 * boot.startTaskRunnerPolling() with ZERO args (and SchedulerBootDeps types the seam
 * `() => { stop(): void }`), so opts.taskCap is undefined on every main-shaped tick — it can
 * only arrive from call sites that pass explicit opts (embedded pollers, tools, tests). The
 * copy stays honest in BOTH directions: it must still name BOTH remedies (each is real to
 * SOME caller), and it must never claim the opts.taskCap half is reachable from scheduler-main
 * — a copy like "…have scheduler-main pass opts.taskCap" REDs here; the wiring half of the
 * claim is pinned by scheduler-main-252-softs.test.ts.
 *
 * S252-S2: task-runner.test.ts "paused tasks skip the queue even when slots are free" called
 * pollTaskRunner(f.deps, {}) — the opts-less form inherits the module-load
 * DEFAULT_MAX_CONCURRENT_RUNS, i.e. the REAL host env. Verified: under an env of 1 the test
 * does NOT flake today, because paused rows are filtered out of the agent grouping BEFORE any
 * cap is consulted (empty byAgent → early return). That isolation is a code ORDERING fact,
 * not a test-design fact — so the call now carries an explicit budget (S249-S2 pattern) and
 * the pin below freezes the ordering: a paused-only queue produces the identical summary at
 * budget 1 and budget 2. Moving the cap-0 check ahead of the paused filter (or dropping the
 * filter) makes the budget-1 arm RED.
 *
 * S256-S1/S2 (#256 ACCEPT soft-pack addendum): S1b above passes `maxConcurrentRuns: 1`
 * EXPLICITLY, so it is "main-shaped" only by coincidence — the LITERAL main path (zero opts,
 * budget inherited from TASK_RUNNER_MAX_CONCURRENT_RUNS=1 at module load) is pinned by
 * task-runner-256-softs.test.ts via a fresh child process; S1b stays for the opts-shape half.
 * S2 narrows the two anti-copy bans below from a bare /scheduler/i to the
 * taskCap↔boot-path-tie pattern (FORBIDDEN_TASKCAP_WIRING_CLAIM).
 *
 * S266-S1/S4 (#266 ACCEPT soft-pack): S4 moves CAP_ZERO_REFUSAL and
 * FORBIDDEN_TASKCAP_WIRING_CLAIM into the shared helper ./task-runner-copy-pins.ts (imported
 * here and by task-runner-256-softs.test.ts — behaviour unchanged, the dedup itself is
 * verified by typecheck + these pins staying green). S1 tightens the matcher: the old 60-char
 * proximity window false-REDd on harmless copy that merely MENTIONS a boot-path word near
 * taskCap; the ban now needs a WIRING VERB in the same clause between the boot-path word and
 * taskCap (either word order). The match/no-match contract is pinned both directions by the
 * S266-S1 corpus test at the bottom of this file.
 *
 * S278-S1/S2/S3 (#278 ACCEPT soft-pack): the S278-S1 rows pin the helper's new long-tail
 * passive branch (the gate-named "opts.taskCap is set automatically when the scheduler
 * starts" was GREEN through every old branch), S278-S2 pins the supplying/sends/sent/
 * fills-in verb additions plus the tight `comes from <boot>` compound branch, and S278-S3
 * closes the gate's surviving M7/M8 mutants by pinning rows that DEPEND on the VERB_TAIL
 * lookahead alternatives and the 5-char AGENT_TO_VERB bound (the "sets aside" false-RED is
 * documented there, not pinned).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pollTaskRunner, startTaskRunnerPolling, type TaskRunnerDeps } from './task-runner';
import { CAP_ZERO_REFUSAL, FORBIDDEN_TASKCAP_WIRING_CLAIM } from './task-runner-copy-pins';
import type { RunnableChatTaskRow } from '@tourbillon/db';
import type { HeartbeatJobData } from '@tourbillon/shared';
import type { WakeResult } from './wake-runner';

// task-runner.ts imports @tourbillon/db at module load, which validates DATABASE_URL eagerly.
process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1/unused';

function row(over: Partial<RunnableChatTaskRow> = {}): RunnableChatTaskRow {
  return {
    companyId: 'company-1',
    agentId: 'agent-1',
    title: 'Ship the runbook',
    notes: null,
    position: 0,
    attempts: 0,
    paused: false,
    sourceThreadId: null,
    agentName: 'Ada',
    agentUrlKey: 'ada',
    agentStatus: 'active',
    companyStatus: 'active',
    ...over,
  } as unknown as RunnableChatTaskRow;
}

interface Collector {
  warns: Array<{ msg: string; data?: Record<string, unknown> }>;
  claims: string[];
  jobs: HeartbeatJobData[];
}

function collectingDeps(rows: RunnableChatTaskRow[], c: Collector): TaskRunnerDeps {
  return {
    db: null as unknown as TaskRunnerDeps['db'],
    listRunnable: async () => rows,
    countActiveRuns: async () => ({ total: 0, task: 0 }),
    claim: async (taskId: string) => {
      c.claims.push(taskId);
      return true;
    },
    startWake: async (job: HeartbeatJobData) => {
      c.jobs.push(job);
      return { runId: job.runId ?? '', status: 'succeeded' } as WakeResult;
    },
    settle: async () => {},
    log: {
      info: () => {},
      warn: (msg: string, data?: Record<string, unknown>) => c.warns.push({ msg, data }),
    },
  } as unknown as TaskRunnerDeps;
}

// CAP_ZERO_REFUSAL and FORBIDDEN_TASKCAP_WIRING_CLAIM are imported from
// ./task-runner-copy-pins.ts (S266-S4 dedup; S266-S1 tightened matcher — rationale and the
// match/no-match contract live with the helper plus the S266-S1 corpus test below).

// ─── S252-S1 ─────────────────────────────────────────────────────────────────

test('S252-S1a: cap-0 refusal names the env remedy and the opts-only remedy without claiming scheduler-main reachability', async () => {
  const c: Collector = { warns: [], claims: [], jobs: [] };
  // Budget 1 → defaultTaskCapPerAgent(1) = 0: the documented cap-0 shape, reached with NO
  // opts.taskCap anywhere (the scheduler-main-shaped opts surface: budget only).
  const s = await pollTaskRunner(collectingDeps([row()], c), { maxConcurrentRuns: 1 });
  assert.equal(s.skippedNoCapacity, 1, 'the refusal path itself must still fire');
  assert.deepEqual(c.claims, [], 'cap-0 never claims — attempt budget untouched');
  assert.deepEqual(c.jobs, [], 'cap-0 never reaches a wake');

  const refusal = c.warns.find((l) => CAP_ZERO_REFUSAL.test(l.msg));
  assert.ok(refusal, 'cap-0 still gets its honest refusal line');
  // Remedy 1: the ONLY knob reachable from scheduler-main (host env → module-load default
  // budget). Without this half the main-path operator has no remedy in the copy at all.
  assert.match(refusal.msg, /TASK_RUNNER_MAX_CONCURRENT_RUNS/, 'names the shared-budget env (the main-reachable remedy)');
  // Remedy 2: real, but ONLY for call sites that pass explicit opts (tools, embedded
  // pollers, tests) — never from main. Kept in the copy because those callers exist.
  assert.match(refusal.msg, /opts\.taskCap/, 'names the explicit override for opts-aware call sites');
  // Anti-copy claim: the copy must not suggest the opts.taskCap half is reachable from the
  // scheduler boot path. Copy like "…or have scheduler-main pass an explicit opts.taskCap"
  // (or any wording tying opts.taskCap to scheduler/main/boot) REDs here — the wiring side of
  // the same honesty is pinned by scheduler-main-252-softs.test.ts (main passes ZERO args).
  // S256-S2: narrowed from a bare /scheduler/i (which REDs on innocent copy merely MENTIONING
  // a scheduler) to the taskCap↔boot-path tie — see FORBIDDEN_TASKCAP_WIRING_CLAIM.
  assert.doesNotMatch(
    refusal.msg,
    FORBIDDEN_TASKCAP_WIRING_CLAIM,
    'the opts.taskCap remedy is intentionally tool/opts-only — the copy must not claim ' +
      'the boot path (which starts the poller with zero args) can pass it',
  );
});

test('S252-S1b: the main-shaped poller path (no opts.taskCap) still lands on the same honest refusal', async () => {
  // startTaskRunnerPolling with opts that a NO-ARGS scheduler-main call plus a budget-1
  // default produce: taskCap forwarded as undefined → derived cap 0. Pins that the refusal
  // the main-shaped tick actually prints keeps BOTH honest remedy halves — operators reading
  // the scheduler log see the env knob they can turn, and nothing claims main can pass opts.
  const c: Collector = { warns: [], claims: [], jobs: [] };
  const poller = startTaskRunnerPolling(collectingDeps([row()], c), {
    intervalMs: 20,
    maxConcurrentRuns: 1,
    // taskCap deliberately NOT passed — the main shape.
  });
  try {
    await poller.whenTicks(1);
  } finally {
    poller.stop();
  }
  const refusals = c.warns.filter((l) => CAP_ZERO_REFUSAL.test(l.msg));
  assert.ok(refusals.length >= 1, 'a main-shaped tick with budget 1 prints the refusal');
  for (const refusal of refusals) {
    assert.match(refusal.msg, /TASK_RUNNER_MAX_CONCURRENT_RUNS/, 'env remedy named');
    assert.match(refusal.msg, /opts\.taskCap/, 'opts-only remedy named');
    assert.doesNotMatch(
      refusal.msg,
      FORBIDDEN_TASKCAP_WIRING_CLAIM,
      'no claim that the boot path can pass opts.taskCap (narrowed from /scheduler/i, S256-S2)',
    );
  }
  assert.deepEqual(c.claims, [], 'the main-shaped cap-0 tick never claims a task');
});

// ─── S252-S2 ─────────────────────────────────────────────────────────────────

test('S252-S2: paused-only queue is cap-independent — identical summary at budget 1 and budget 2', async () => {
  // The :172 test in task-runner.test.ts runs exactly this shape (one paused row) via
  // pollTaskRunner(f.deps, {}), which inherits the module-load env default. Under a host
  // env of 1 it does not flake TODAY — paused rows leave byAgent empty and the tick returns
  // before any cap is consulted. That isolation is the ORDERING (paused filter before the
  // cap-0 check), so freeze the ordering directly: with budget 1 the budget-1 arm must NOT
  // fall into the cap-0 refusal. Delete `if (row.paused === true) continue;` (or move the
  // cap-0 check ahead of the grouping) and the budget-1 arm REDs with
  // skippedNoCapacity = 1 instead of 0.
  for (const maxConcurrentRuns of [2, 1]) {
    const c: Collector = { warns: [], claims: [], jobs: [] };
    const s = await pollTaskRunner(collectingDeps([row({ taskId: 't1', paused: true })], c), {
      maxConcurrentRuns,
    });
    assert.equal(s.polled, 1, `budget ${maxConcurrentRuns}: the row is still polled`);
    assert.equal(s.started.length, 0, `budget ${maxConcurrentRuns}: paused never starts`);
    assert.equal(s.skippedFull, 0, `budget ${maxConcurrentRuns}: not a budget deferral`);
    assert.equal(
      s.skippedNoCapacity,
      0,
      `budget ${maxConcurrentRuns}: a paused-only queue must not consult the cap — ` +
        'the cap-0 refusal is for QUEUED work, not filtered-out work',
    );
    assert.equal(s.skippedInactive, 0);
    assert.deepEqual(c.claims, [], `budget ${maxConcurrentRuns}: no claim, attempts untouched`);
    assert.deepEqual(c.jobs, [], `budget ${maxConcurrentRuns}: no wake`);
  }
});

// ─── S266-S1 ─────────────────────────────────────────────────────────────────

test('S266-S1: the wiring-claim matcher keeps harmless copy GREEN and real forbidden claims RED (both directions)', () => {
  // Direction 1 — harmless copy the OLD 60-char proximity window false-REDd: it MENTIONS a
  // boot-path word within 60 chars of taskCap without ever tying opts.taskCap to the boot
  // path. Each line here used to break assert.doesNotMatch in S252-S1a/S1b/S256-S1.
  const HARMLESS = [
    // The real production refusal line (task-runner.ts :407) — must stay GREEN forever.
    'task-run capacity zero, refusing — Run Tasks cannot start for this agent while the ' +
      'effective task cap is 0 (raise TASK_RUNNER_MAX_CONCURRENT_RUNS to ≥ 2, or pass an ' +
      'explicit opts.taskCap ≥ 1)',
    // S256-S2 named this shape as the false positive to fix: a mere log pointer.
    '…or pass an explicit opts.taskCap ≥ 1 (see the scheduler log)',
    // Past-tense provenance + a later-clause remedy verb — the clause-breaker keeps it GREEN.
    'the cap was raised from the scheduler defaults; pass opts.taskCap explicitly',
    // Truthful division-of-labour copy: "main" and "pass opts.taskCap" in separate clauses.
    'the main tick derives the budget from env; tools may pass opts.taskCap',
    // Parenthetical boot mention after the remedy.
    'opts.taskCap is tool-only — see the boot log for the env default',
    // "setting" is deliberately NOT a wiring verb (innocent "the setting lives in…" copy).
    'raise TASK_RUNNER_MAX_CONCURRENT_RUNS or pass opts.taskCap — the setting lives in the scheduler config',
  ];
  for (const copy of HARMLESS) {
    assert.doesNotMatch(
      copy,
      FORBIDDEN_TASKCAP_WIRING_CLAIM,
      `harmless copy must stay GREEN (S266-S1 false-positive fix): ${copy}`,
    );
  }

  // Direction 2 — the real forbidden claims: a wiring verb in ONE CLAUSE tying taskCap to
  // the boot path, in BOTH word orders. Mutating the matcher loose again REDs here, so the
  // narrowing above cannot quietly become a no-op.
  const FORBIDDEN = [
    // The S256-S2 documented mutant (boot word → verb → taskCap).
    'task-run capacity zero, refusing — Run Tasks cannot start for this agent while the ' +
      'effective task cap is 0 (raise TASK_RUNNER_MAX_CONCURRENT_RUNS to ≥ 2, or have ' +
      'scheduler-main pass an explicit opts.taskCap ≥ 1)',
    'the scheduler passes opts.taskCap for you',
    'or let boot supply the explicit opts.taskCap you need',
    'the main loop can set opts.taskCap itself',
    // taskCap → verb → boot word order.
    'opts.taskCap set at boot covers most cases',
    'wire opts.taskCap through the scheduler config',
    // S256-S2 comment's named must-stay-RED shape (≈45 chars between the tokens).
    'or pass opts.taskCap through the boot seam',
  ];
  for (const copy of FORBIDDEN) {
    assert.match(
      copy,
      FORBIDDEN_TASKCAP_WIRING_CLAIM,
      `forbidden wiring claim must stay RED (S266-S1 non-vacuity): ${copy}`,
    );
  }
});

// ─── S272-S1 / S272-S2 ───────────────────────────────────────────────────────

test('S272-S1: inflected wiring verbs (supplies/supplied/providing) RED, honest near-misses GREEN', () => {
  // The old alternation had two dead branches: `supply(?:ies|ied)?` could only ever match
  // the non-words "supplyies"/"supplyied", and `provid(?:e|es|ed)` had no -ing branch.
  // The boot path as PROVIDER in any real inflection must RED — loosen the stem fix and a
  // row here goes RED-for-the-wrong-reason no more: these rows fail when the fix regresses.
  const FORBIDDEN = [
    'the scheduler supplies opts.taskCap for you',
    'boot supplied the explicit opts.taskCap',
    'the scheduler is providing opts.taskCap automatically',
  ];
  for (const copy of FORBIDDEN) {
    assert.match(
      copy,
      FORBIDDEN_TASKCAP_WIRING_CLAIM,
      `inflected wiring claim must stay RED (S272-S1): ${copy}`,
    );
  }

  // Honest near-misses: the fixed stems must not smear into ordinary copy where supplies/
  // providing govern something OTHER than taskCap (the verb ties docs/logs/context, never
  // the boot path to the cap). Same-clause breakers (; and :) keep these GREEN.
  const HARMLESS = [
    'the log supplies context for the refusal; the tool passes opts.taskCap explicitly',
    'the scheduler log supplies the env value; you may pass opts.taskCap yourself',
    'we are providing docs, not config: the tools pass opts.taskCap explicitly',
  ];
  for (const copy of HARMLESS) {
    assert.doesNotMatch(
      copy,
      FORBIDDEN_TASKCAP_WIRING_CLAIM,
      `honest inflected near-miss must stay GREEN (S272-S1): ${copy}`,
    );
  }
});

test('S272-S2: wiring verbs in relative clauses RED (head-as-object and wide-window), honest relatives GREEN', () => {
  // The S266-S1 same-clause windows only glue CLOSE tokens, so moving the wiring verb into
  // a relative clause escaped the ban: the head is the verb's object (nothing re-states
  // taskCap after the verb) and the gaps exceed both connector windows. These shapes claim
  // exactly what CAP-zero copy must never claim — the boot path provides opts.taskCap.
  const FORBIDDEN = [
    // Agentive relative, head-as-object (verb 28+ chars from the head token).
    'opts.taskCap, which the scheduler passes at boot, is gone',
    'opts.taskCap which the scheduler supplies at boot is gone',
    'opts.taskCap is the value which the scheduler passes',
    'opts.taskCap that the main tick forwards to tools at boot is removed',
    'opts.taskCap, which the scheduler passes for you, is gone',
    // Relative with an EXPLICIT taskCap object in a wide verb→object window.
    'there is a note which says the scheduler passes the number of slots as opts.taskCap',
    // Passive relatives that ONLY the S272-S1 stem fix can reach (double-bug rows:
    // loosen either soft and these slip GREEN).
    'opts.taskCap, which is supplied by the scheduler, covers most cases',
    'opts.taskCap, which is provided by the boot wrapper, covers most cases',
  ];
  for (const copy of FORBIDDEN) {
    assert.match(
      copy,
      FORBIDDEN_TASKCAP_WIRING_CLAIM,
      `relative-clause wiring claim must stay RED (S272-S2): ${copy}`,
    );
  }

  // Honest relatives stay GREEN: a relative with no wiring verb, a boot word that merely
  // appears inside the relative without tying to taskCap, or a verb whose subject is some
  // other noun (the tools read the cap; the scheduler merely appears as defaults prose).
  const HARMLESS = [
    'opts.taskCap, which is undocumented today, is read-only',
    'opts.taskCap, which the boot log merely mentions, is tool-only',
    'opts.taskCap, which is undefined at boot, comes from env later',
    'the tools, which read opts.taskCap, never see the scheduler defaults',
    'opts.taskCap is the value you get from the scheduler defaults only when env is unset',
  ];
  for (const copy of HARMLESS) {
    assert.doesNotMatch(
      copy,
      FORBIDDEN_TASKCAP_WIRING_CLAIM,
      `honest relative-clause copy must stay GREEN (S272-S2): ${copy}`,
    );
  }
});

// ─── S278-S1 / S278-S2 ───────────────────────────────────────────────────────

test('S278-S1: long-tail passives (tight copula, verb past the 15-char window) RED; comma-bounded and beyond-tail honest copy GREEN', () => {
  // The S272-S2 note named this open shape: "opts.taskCap is set automatically when the
  // scheduler starts" was GREEN — `set` sits 24 chars from `scheduler` (" automatically
  // when the "), past the 15-char verb→boot window, and no other branch reaches it. The
  // helper gained a dedicated tight-copula passive branch (taskCap is|was|… <participle>
  // …≤30 non-comma chars… <boot>). Dropping that branch REDs a row here — the old
  // long-tail-passive mutant can no longer survive.
  const FORBIDDEN = [
    // The Test-gate named shape (was GREEN through all four old branches).
    'opts.taskCap is set automatically when the scheduler starts',
    'opts.taskCap is supplied automatically when main boots',
    'opts.taskCap is configured automatically when the boot wrapper runs',
  ];
  for (const copy of FORBIDDEN) {
    assert.match(
      copy,
      FORBIDDEN_TASKCAP_WIRING_CLAIM,
      `long-tail passive wiring claim must be RED (S278-S1): ${copy}`,
    );
  }

  // Passive-branch contract rows: the tail may not cross a COMMA (honest agent-swaps stay
  // GREEN even with a boot word just past one), the tail is BOUNDED at 30 chars (the
  // known-miss beyond it is pinned so the bound cannot silently drift), and the copula
  // must be TIGHT (an adverb between copula and participle is the other documented
  // known-miss — loosen the branch to swallow "is usually set by…" and the first two rows
  // here fail alongside the real lie shapes).
  const HARMLESS = [
    'opts.taskCap is set by the tool, not the scheduler',
    'opts.taskCap is set well before the checks the poller makes against the scheduler default',
    'opts.taskCap is usually set by tools at tick time',
  ];
  for (const copy of HARMLESS) {
    assert.doesNotMatch(
      copy,
      FORBIDDEN_TASKCAP_WIRING_CLAIM,
      `honest passive-shaped copy must stay GREEN (S278-S1): ${copy}`,
    );
  }
});

test('S278-S2: supplying/sends/sent/fills in RED as wiring verbs; comes from <boot> RED as a tight compound; honest uses GREEN', () => {
  // S272-S1 stopped at `supplied` — "the scheduler is supplying opts.taskCap" was GREEN.
  // The decided calls from the brief: `sends`/`sent` and `fills in` join WIRING_VERB as
  // real wiring verbs; `comes from` does NOT (a bare-verb fold false-REDs the honest
  // S272-S2 row "opts.taskCap, which is undefined at boot, comes from env later" via the
  // head-anchored relative $-tail — see COMES_FROM in the helper). Drop any stem or the
  // compound branch and a row here goes GREEN-for-the-wrong-reason no more.
  const FORBIDDEN = [
    'the scheduler is supplying opts.taskCap',
    'boot is supplying the explicit opts.taskCap',
    'the scheduler sends opts.taskCap for you',
    'boot sent the explicit opts.taskCap',
    'the scheduler fills in opts.taskCap automatically',
    'opts.taskCap comes from the scheduler defaults',
  ];
  for (const copy of FORBIDDEN) {
    assert.match(
      copy,
      FORBIDDEN_TASKCAP_WIRING_CLAIM,
      `inflected wiring claim must stay RED (S278-S2): ${copy}`,
    );
  }

  // Honest near-misses: the new verbs govern something OTHER than taskCap (clause-breakers
  // do the work), and `comes from` stays GREEN unless a boot word sits TIGHT after it —
  // the 18-char gap in the denial row exceeds the 15-char compound window.
  const HARMLESS = [
    'the scheduler sends log lines; the tool passes opts.taskCap explicitly',
    'the boot log sends a reminder line; the caller passes opts.taskCap',
    'the scheduler fills in the missing title; you may pass opts.taskCap yourself',
    'opts.taskCap comes from env, not from the scheduler',
  ];
  for (const copy of HARMLESS) {
    assert.doesNotMatch(
      copy,
      FORBIDDEN_TASKCAP_WIRING_CLAIM,
      `honest near-miss for the new verbs must stay GREEN (S278-S2): ${copy}`,
    );
  }
});

// ─── S278-S3 ─────────────────────────────────────────────────────────────────

test('S278-S3: the relative VERB_TAIL lookaheads and the 5-char AGENT_TO_VERB bound are non-vacuous', () => {
  // Gate mutants M7/M8 survived on #272: no corpus row DEPENDS on the VERB_TAIL lookahead
  // alternatives (the $-alternative shadows them for every short-tail row), and nothing
  // punished widening AGENT_TO_VERB from 5 to 25 chars. These rows close both holes:
  //  - FORBIDDEN rows whose tail exceeds 20 chars before end-of-string — only the comma /
  //    keyword lookaheads reach them, so dropping the lookaheads (M7) slips a row GREEN.
  //  - the HARMLESS row has its wiring verb 11 chars past the boot subject — inside the
  //    old 5-char bound it is GREEN, at 25 (M8) the verb binds and it false-REDs.
  const FORBIDDEN = [
    // RED only via `VERB_TAIL(?=[,.;:])` — " at boot" then the comma; the $-tail would need
    // to swallow 30+ chars to reach end-of-string.
    'opts.taskCap, which the scheduler passes at boot, is a value nobody reads in the logs',
    // RED only via the keyword lookahead (`to`): "forwards" + " to" at the tail head.
    'opts.taskCap which the scheduler forwards to the tools is gone from the codebase and nobody misses it',
  ];
  for (const copy of FORBIDDEN) {
    assert.match(
      copy,
      FORBIDDEN_TASKCAP_WIRING_CLAIM,
      `tail-lookahead wiring claim must stay RED (S278-S3 / M7): ${copy}`,
    );
  }

  // "sets out to document" is honest copy — the scheduler log documents, it does not
  // provide. The 11-char boot→verb gap is what keeps it GREEN.
  assert.doesNotMatch(
    'opts.taskCap, which the scheduler log merely sets out to document, is read-only',
    FORBIDDEN_TASKCAP_WIRING_CLAIM,
    'boot→verb gap of 11 chars must stay GREEN (S278-S3 / M8 AGENT_TO_VERB bound)',
  );

  // Documented false-RED (info soft, NOT pinned GREEN — the gate probe): "opts.taskCap
  // that the boot log sets aside is unrelated" REDs via branch 3 because `sets` is a
  // genuine wiring verb sitting tight after "boot " and the $-tail swallows the 19-char
  // " aside is unrelated". The matcher cannot tell "sets aside" (idiom, harmless) from
  // "sets" (provides, lie) without a semantic model; production refusal copy is
  // unaffected (CAP_ZERO_REFUSAL pins stay GREEN). Left as a documented known false
  // positive — a per-idiom tail blacklist was judged not worth the fragility.
});
