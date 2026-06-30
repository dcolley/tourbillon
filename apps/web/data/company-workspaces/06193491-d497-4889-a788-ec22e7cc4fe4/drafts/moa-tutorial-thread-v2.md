# Council of Agents (MoA) Tutorial Thread — Draft v2 (Revision per Curator Feedback)

**Issue:** XP-9 | **Priority:** CRITICAL/OVERDUE  
**Author:** Author (Agent) | **Date:** 2026-07-15

---

## Tweet 1/10 (Hook)
my CEO agent doesn't just "think." it delegates to a CTO, they review each other's work, merge their thoughts, and neither could produce what comes out the other side.

sitting on my dgx spark running aeon-7. here's how i set up a council of agents pattern in production (and why single-agent systems are holding you back) 🧵

## Tweet 2/10
what is moa?

multi-agent deliberation: instead of one ai agent making decisions alone, you run multiple agents that critique → refine → merge each other's outputs before anything reaches the user.

it's not "more agents = better" (you just get more latency). it's about structured review loops where every agent has a specific role: drafter, critic, merger.

## Tweet 3/10
why this matters for single-agent systems:

one blind spot — your own agent can't catch its own hallucinations or reasoning gaps because there's no second pair of eyes.

with moa, each agent serves as reviewer for the others. catching factual errors before they propagate to you. the output is sharper and more fact-checked.

my ai reports: the cto caught a planning error in the ceo's approach that would've shipped directly to production otherwise. sit with that.

## Tweet 4/10
tourbillon setup (what i actually run):

ceo agent → delegates task to CTO agent  
cto reviews ceo's plan, adds technical depth + catches gaps  
they merge outputs into one final response  

both on aeon-7 via mastra framework. all local — dgx spark hardware, 0 api costs, just electricity.

latency tradeoff: takes about 2x longer to get an answer vs single agent. but the quality gap is actually noticeable every time i run it. not marginal.

## Tweet 5/10
how to set this up (mastra workflow config):

the key isn't fancy code — it's clear role definitions in each agent's system prompt. here's what mine looks like:

ceo agent system_prompt: "you are the ceo of this operation. break down tasks, delegate to specialists, and synthesize their work into a final response."

cto agent system_prompt: "you are the technical reviewer. examine the ceo's plan for gaps, factual errors, missing context, and feasibility issues. suggest concrete improvements."

merge step: take both outputs → combine strengths from each → produce unified response that neither would've alone.

## Tweet 6/10
why mastra (from @NousResearch) works well for this:

they open-sourced the framework specifically with multi-agent orchestration in mind. what made it click vs alternatives?

- workflow engine lets you chain deliberation steps naturally (no hacky loops)
- each agent gets its own system prompt + tool set — no fighting over shared context
- handoff conditions are explicit: "don't pass to merger until both agents have submitted their review"

but honestly? the prompts matter more than the framework. get role clarity right and this pattern works anywhere. mastra just makes it easier to not mess up.

## Tweet 7/10
real tradeoffs (not magic, be honest about when you need it):

→ latency: ~2x slower per response in my setup. ceo draft + cto review + merge = more tokens, more time
→ cost: on cloud apis this gets expensive fast. local? near-zero on dgx spark
→ complexity: more moving parts to debug. if your single agent is already 90% there, maybe don't bother

only use when the decision has real downstream consequences and you need fact-checking across domains. otherwise single agent is fine. don't over-engineer.

## Tweet 8/10
when i use council pattern vs single agent:

use it for:
- decisions with real downstream consequences (architecture reviews, code merges)
- cross-domain tasks where one agent's blind spot matters
- anything requiring both planning AND execution review

skip it for:
- simple q&a or fast tool calls
- anything where speed > accuracy
- when you're still debugging your single agent setup (fix the foundation first)

## tweet 9/10
what i've actually seen in production with aeon-7 on dgx spark:

ceo↔cto deliberation caught a planning error last week — cto spotted that the ceo's approach would've required a database migration we hadn't planned for. single agent would've shipped it straight to prod and crashed hard.

deeper reasoning too: agents push past surface answers when they know someone else is reviewing their work.

fun fact: this is basically what high-precision self-verification does with one model (ornith fp8). the difference is moa lets you delegate that critical thinking to a specialist rather than hoping your single agent can do it all.

## tweet 10/10 (close)
big thanks to @NousResearch for open-sourcing mastra — this pattern works because frameworks like theirs make it actually implementable instead of staying theoretical.

i'll be sharing more about tourbillon's architecture in upcoming posts. questions? i run the whole thing locally on dgx spark if you want specifics 🤙

---
**Status:** Ready for Curator review → post to @derekcolley_
