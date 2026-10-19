# Backlog: Harness introspection, evals & self-improvement

**Status:** Research note / backlog proposal
**Date:** 2026-10-19
**Context:** Agents currently create busy work; observability (Phoenix-backed, dev-team-only) records raw traces but nothing mines them. Goal: find patterns, detect off-script/tangent behaviour, and propose or auto-tune agent prompts, skills, and tools from findings.

References:

- Google's open-source [Harness²](https://github.com/google-research/harness2) (arXiv 2610.14224): *Propose-Probe-Compose* — an agent proposes edits to its own harness (prompt/tools/skills/subagents), runs candidate versions per task, compares behavior differences between runs, and composes a better harness **without a ground-truth grader**. Lessons that hold up across tasks are carried into the next round of edits. Model weights untouched.
- Opik (Comet): the production analogue — failing trace → root cause → proposed fix → permanent regression test so the same failure can't come back.

## Why this fits tourbillon well

The harness is already **just data**: an `agents` row (`instructionsBundleSoulMd`/`AgentsMd`, `assignedSkills`, `assignedToolsets`, `mcpServerIds`, model/provider, budget, `runtimeConfig`) plus SKILL.md files injected at wake time. "Auto-tune the harness" means writing a new version of that row with provenance — not shipping code.

The raw material exists: `agent_observability_events` is fully dimensioned (company / agent / issue / job / project / goal / heartbeatRun / trace-span) with `eventType`, tool id, token/duration/status, and error text, exported to Phoenix via OTLP (`@mastra/arize`). Prior art for inline detection: `packages/mastra/src/observability/tripwire-detector.ts` (registry pattern the exporter notifies per span), `packages/scheduler/src/tool-call-signature.ts`, and `wake-context` fixtures that are effectively replayable wake seeds.

Tourbillon also beats the benchmark setting: as an *orchestration* product, the environment is its own grader — issue status transitions, PR merges, human approvals/rejections, budget burn per completed issue. Harness² needs "no correct answer" because its benchmarks lack one; we don't.

## Architecture: four layers

### 1. Attribution stamps (Phase 0 — prerequisite)

Today you cannot tell which harness version produced a trace. Before any evals, every wake should stamp the trace with:

- `harnessVersion` — hash of instructions + skills + toolsets
- skills actually injected vs actually used
- `goalRef` / goal-hash for the task

Without this, nothing downstream is comparable (you cannot "compare how runs behaved" if runs aren't comparable). Small change: `map-span.ts` / `harness-event-writer.ts` / wake context.

### 2. Inline divergence detectors (synchronous)

Generalize the `tripwireDetectorRegistry` pattern. New event types for the "off script" cases:

| Signal | Detection |
|---|---|
| `no_progress` | N near-identical tool-call signatures in one wake (uses `tool-call-signature.ts`) |
| `off_issue_work` | tool-call targets don't match trace `issueId`/`goalId`, or work outside assigned issues |
| `skill_disuse` | injected `assignedSkills` never invoked (and the inverse: ad-hoc heuristics where a skill exists) |
| `role_drift` | tool/permission use outside `assignedToolsets` |

Cheap rules, same events table, turns "busy work" from a vibe observation into a queryable incidents surface.

### 3. Async evals + pattern mining (nightly batch)

- **Reference-free pairwise** (the Harness² idea): cluster traces by task type (role × goal-semantic-similarity), LLM judge compares traces within a cluster — no ground truth. Phoenix already provides judge/eval plumbing and dataset views.
- **Grounded outcome evals**: outcome signals above as the primary metric; pairwise comparison only explains *why* outcomes differ.

Two new tables:

- `agent_insights` — per-agent/role/tenant failure patterns with evidence trace ids (this is Harness²'s "lessons that held up across runs", carried between tasks).
- `harness_versions` — immutable configs + diff + provenance (which insights and which probe traces justified it).

### 4. Change loop: Propose → Probe → Compose (adapted)

- **Propose:** a harness-doctor agent (fits the control-plane toolset) reads `agent_insights` + flagged traces and emits a *diff* on the agents row / skill file. Config is text → diffs/reviewability free.
- **Probe:** can't A/B tenants, so replay recorded flagged wakes (anonymized per-tenant fixtures — watch company-data leakage; this is exactly what cross-tenant probes must not leak) in a sandbox company against candidate harness versions; score behavior differences pairwise, no grader.
- **Compose:** pick winning config per lever (instructions vs skills vs tools fix different failure classes — keep attribution separate), apply to 1–10% shadow, auto-rollback if outcome metrics degrade.

**Opik regression property:** every failing fixture becomes a permanent regression test that every future harness version must pass before promotion.

## Two warnings that matter more than the fun parts

1. **Self-referential feedback loops.** If the doctor tunes on traces produced by its own recent edits, you optimize toward the detector's blind spots. Keep a small frozen holdout set of traces/agents never subject to tuning, used to validate edits.
2. **Auto-apply is the danger zone.** An agent editing its own SOUL.md in production is a prompt-injection escalation path: a hostile page that can steer an agent can now steer its *persistence*. Default posture: proposals land as rows in the existing `approvals` table, human-reviewed. Auto-apply only for provably non-semantic levers (timeouts, skill ordering) or purely on sandbox/probe evidence with canary + rollback. Per-company opt-out hook (à la `OBSERVABILITY_ENABLED`).

## First PR (concretely)

Phase 0 stamps + three inline detectors (`no_progress`, `off_issue_work`, `skill_disuse`) + a `v_insight_*` materialized view. That alone converts "agents create busy work" into sentences like *"the CEO agent's plan-to-tasks skill goes unused on 40% of planning wakes, correlating with 3× step counts"* — which makes every decision downstream obvious.

## Phasing

| Phase | Deliverable |
|---|---|
| 0 | Harness-version stamps + skill/goal stamps on every trace |
| 1 | Inline divergence detectors + insight materialized views |
| 2 | Judge evals on sampled traces (Phoenix) + outcome evals from issues/approvals |
| 3 | `agent_insights` / `harness_versions` tables, harness-doctor proposer, replay rig |
| 4 | Shadow/canary application, auto-rollback, regression fixtures |
| 5 | Cross-task lesson carry-forward (frozen holdout + per-tenant lesson store) |
