/**
 * Shared copy-pins for the task-runner cap-0 refusal (S266-S4: deduplicated from
 * task-runner-252-softs.test.ts and task-runner-256-softs.test.ts — both files import
 * these, behaviour unchanged; the corpus proof lives in task-runner-252-softs.test.ts
 * under the S266-S1 pin).
 *
 * The cap-0 refusal copy (task-runner.ts) names two remedies — raise
 * TASK_RUNNER_MAX_CONCURRENT_RUNS to ≥ 2, or pass an explicit opts.taskCap ≥ 1. They are
 * NOT equally reachable: scheduler-main starts the poller with ZERO args (pinned by
 * scheduler-main-252-softs.test.ts), so opts.taskCap is undefined on every main-shaped
 * tick. The copy must therefore stay honest in BOTH directions:
 *   - name BOTH remedies (each is real to SOME caller) — pinned by CAP_ZERO_REFUSAL plus
 *     the per-remedy assert.match sites in the two softs files; and
 *   - never claim the opts.taskCap half is reachable from the scheduler boot path —
 *     pinned by FORBIDDEN_TASKCAP_WIRING_CLAIM.
 */

/** The dedicated warn line the poller prints when the derived task cap is 0. */
export const CAP_ZERO_REFUSAL = /task-run capacity zero, refusing/;

/**
 * The boot-path words a refusal copy must never tie `opts.taskCap` to.
 * `\b` guards: "maintain", "domain", "bootstrapping" never match.
 */
const BOOT_PATH = String.raw`\b(?:scheduler|main|boot)\b`;

/**
 * S266-S1 (#266 ACCEPT soft-pack): wiring verbs — words that would make the boot path the
 * PROVIDER of opts.taskCap ("scheduler-main pass opts.taskCap", "boot supply", "set at
 * boot", "wired to the scheduler"). Bare proximity is NOT forbidden any more: the old
 * 60-char window REDd on harmless copy that merely MENTIONS a boot-path word near taskCap
 * ("…pass an explicit opts.taskCap ≥ 1 (see the scheduler log)", "raised from the
 * scheduler defaults; pass opts.taskCap explicitly") without claiming anything. What stays
 * forbidden is a copy that puts one of THESE verbs inside the same clause between the
 * boot-path word and `taskCap` — the actual lie shape. Clause-breaker characters
 * (. ; : and em/en dashes) are excluded from the connector windows so a later sentence or
 * parenthetical mentioning a boot word can never be glued to an earlier remedy verb.
 * Notably absent: `setting` (matches innocent "the setting lives in…"), `from`/`by`
 * (too common in harmless prepositional copy — "opts.taskCap set by the scheduler" still
 * REDs via `set`; "raised from the scheduler" stays GREEN by design).
 *
 * S272-S1 (#272 ACCEPT soft-pack): two inflections in the old alternation were dead
 * branches — `supply(?:ies|ied)?` needed the y→ies/lied stem change, so it only ever
 * matched the non-words "supplyies"/"supplyied" while `supplies`/`supplied` slipped
 * through GREEN; and `provid(?:e|es|ed)` had no `-ing` branch, missing `providing`.
 * Both fixed here and pinned by the S272-S1 corpus rows in task-runner-252-softs.test.ts.
 */
const WIRING_VERB = String.raw`\b(?:pass(?:es|ed|ing)?|supp(?:ly|lies|lied)|forward(?:s|ed|ing)?|set(?:s)?|wir(?:e|es|ed|ing)|configur(?:e|es|ed|ing)|provid(?:e|es|ed|ing)|via|through)\b`;

/** Boot-path word → wiring verb (subject position, same clause). */
const SAME_CLAUSE_TO_VERB = '[^.;:\\u2014\\u2013\\n]{0,25}';
/** Wiring verb → its object `taskCap` (only determiners/modifiers may intervene). */
const SAME_CLAUSE_TO_TASKCAP = '[^.;:\\u2014\\u2013\\n]{0,20}';
/** The token itself — the `opts.` qualifier sits OUTSIDE the clause windows so its dot
 *  never trips the clause-breaker class. */
const TASKCAP_TOKEN = String.raw`(?:opts\.)?taskCap`;
/** Wiring verb → boot-path word (tight: only a prepositional tail may intervene). */
const SAME_CLAUSE_TO_BOOT = '[^.;:\\u2014\\u2013\\n]{0,15}';

/**
 * S272-S2 (#272 ACCEPT soft-pack): the same-clause pin above only glues tokens that sit
 * CLOSE together, so a wiring verb hiding in a RELATIVE CLAUSE slipped through GREEN —
 * "opts.taskCap, which the scheduler passes at boot, …" puts `passes` 28+ chars from the
 * head token (outside both windows), and "…which the scheduler passes the number of slots
 * as opts.taskCap" widens the verb→object gap past 20 chars. Two extra branches close
 * that surface WITHOUT touching the same-clause windows (their honest-copy contract is
 * pinned unchanged by S266-S1):
 *   1. head-anchored agentive relative: `taskCap … which|that … <boot> <verb>` — the head
 *      IS the verb's object, so the clause may END at the verb (bounded tail: clause
 *      terminator, end of string, or a short prepositional tail like "for you"). The
 *      tail is bounded so a relative whose verb governs some other object stays GREEN
 *      ("opts.taskCap, which the boot log merely mentions, …" — no wiring verb anyway).
 *   2. unanchored relative with an EXPLICIT taskCap object: `which|that … <boot> <verb>
 *      … taskCap` (40-char verb→object window). The boot-path word must sit TIGHT to its
 *      verb (same filler bound as the same-clause pin), so a relative whose subject is
 *      some other noun stays GREEN: "the tools, which read opts.taskCap, never see the
 *      scheduler defaults" has no boot-adjacent wiring verb ("defaults" is 8 chars from
 *      `scheduler`, outside the filler window).
 * Passive relatives ("which is supplied by the scheduler") are covered by branch 2 of the
 * same-clause pin ONCE the S272-S1 inflection fix lands — before it, `is supplied` had no
 * matching verb and the whole shape escaped.
 */
const RELATIVE_PRONOUN = String.raw`(?:which|that)`;
/** taskCap head → relative pronoun (short copula/attribute span only). */
const HEAD_TO_RELATIVE = '[^.;:\\u2014\\u2013\\n]{0,20}';
/** Relative pronoun → boot-path subject of the relative clause. */
const RELATIVE_TO_AGENT = '[^.;:\\u2014\\u2013\\n]{0,25}';
/** Boot-path subject → its verb (only "says"/"is"/"for you"-scale filler). */
const AGENT_TO_VERB = '[^.;:\\u2014\\u2013\\n]{0,5}';
/** Head-as-object tail: the relative may end shortly after the verb. */
const VERB_TAIL = '[^.;:\\u2014\\u2013\\n]{0,20}';
/** Wide verb → explicit taskCap object window (only inside a relative clause). */
const RELATIVE_VERB_TO_TASKCAP = '[^.;:\\u2014\\u2013\\n]{0,40}';

/**
 * The narrowed wiring-claim ban (S256-S2 heritage, S266-S1 tightening, S272-S1 inflection
 * fix, S272-S2 relative clauses). Forbidden shapes —
 * a wiring verb tying the boot path to `taskCap` within one clause, in either word order:
 *   <boot> … <verb> … taskCap   e.g. "have scheduler-main pass an explicit opts.taskCap"
 *   taskCap … <verb> … <boot>   e.g. "opts.taskCap set at boot", "wire opts.taskCap
 *                               through the scheduler"
 * plus the S272-S2 relative-clause shapes (see the block comment above).
 * The old pattern (/taskCap[\s\S]{0,60}\b(scheduler|main|boot)\b|…/i) demanded only
 * proximity, so harmless mentions within 60 chars false-REDd. See the S266-S1 corpus pin
 * in task-runner-252-softs.test.ts for the accepted match/no-match contract (S266-S1
 * rows), plus the S272-S1/S2 rows for the inflection and relative-clause contract.
 */
export const FORBIDDEN_TASKCAP_WIRING_CLAIM = new RegExp(
  `${BOOT_PATH}${SAME_CLAUSE_TO_VERB}${WIRING_VERB}${SAME_CLAUSE_TO_TASKCAP}${TASKCAP_TOKEN}` +
    `|${TASKCAP_TOKEN}${SAME_CLAUSE_TO_TASKCAP}${WIRING_VERB}${SAME_CLAUSE_TO_BOOT}${BOOT_PATH}` +
    `|${TASKCAP_TOKEN}${HEAD_TO_RELATIVE}${RELATIVE_PRONOUN}${RELATIVE_TO_AGENT}${BOOT_PATH}${AGENT_TO_VERB}${WIRING_VERB}(?:${RELATIVE_VERB_TO_TASKCAP}${TASKCAP_TOKEN}|${VERB_TAIL}$|${VERB_TAIL}(?=[,.;:])|${VERB_TAIL}(?=\\s+(?:for|to|it|you|tools?)\\b))` +
    `|${RELATIVE_PRONOUN}${RELATIVE_TO_AGENT}${BOOT_PATH}${AGENT_TO_VERB}${WIRING_VERB}${RELATIVE_VERB_TO_TASKCAP}${TASKCAP_TOKEN}`,
  'i',
);
