# Council of Agents (MoA) Tutorial Thread — Draft v1

**Issue:** XP-9 | **Priority:** CRITICAL/OVERDUE  
**Author:** Author (Agent) | **Date:** 2026-07-15

---

## Tweet 1/10 (Hook)
I've been running a Council of Agents pattern in production for weeks. Here's how to set one up. 🧵

In Tourbillon, my CEO agent doesn't just "think" — it delegates to a CTO, they review each other's work, merge their thoughts, and produce something neither could alone.

## Tweet 2/10
What is MoA?

Multi-Agent deliberation: instead of one AI agent making decisions in isolation, you run multiple agents that critique, refine, and merge each other's outputs before delivering a final response.

It's not "more agents = better." It's about structured review loops where every agent has a specific role — drafter, critic, merger.

## Tweet 3/10
Why it works (and why your single agent isn't enough)

Single-agent systems have one blind spot: the agent can't catch its own hallucinations or miss reasoning gaps because there's no second pair of eyes. With MoA, each agent serves as a reviewer for the others — catching errors before they propagate to the user.

The output is sharper, more fact-checked, and deeper.

## Tweet 4/10
The pattern in Tourbillon (my setup):

CEO Agent → delegates to CTO Agent  
CTO reviews CEO's plan, adds technical depth  
They merge their outputs into one response  

Both run on AEON-7 models via the Mastra framework. All local — DGX Spark hardware, zero API costs.

## Tweet 5/10
How to implement it (general architecture):

```
Agent A: drafts output
↓
Agent B: critiques + suggests improvements  
↓
Agent C (or merged): produces final response
↓
Only what passes review reaches the user
```

Each agent needs a clear role. "Reviewer" isn't vague — it's "find factual errors and missing context in Agent A's draft."

## Tweet 6/10
Using Mastra (by @NousResearch):

They open-sourced this framework specifically for multi-agent orchestration. The key pieces:

- Define each agent with its own system prompt + tools  
- Use their workflow engine to chain deliberation steps  
- Set clear handoff conditions between agents  

The prompts matter more than the framework. Get role clarity right and it works anywhere.

## Tweet 7/10
Real tradeoffs (this isn't magic):

→ Latency: each review round adds time. CEO+CTO takes ~2x longer than a single agent response.  
→ Cost: cloud APIs make this expensive. Local? Near-zero on DGX Spark.  
→ Quality: only worth it for complex decisions. Simple queries? Single agent is fine.  

Be honest about when you need it.

## Tweet 8/10
When to use MoA vs single agent:

DO use Council pattern when:
- Decision has real downstream consequences  
- You need fact-checking across domains  
- The task requires both planning AND execution review  

DON'T overuse for:
- Simple Q&A or fast tool calls (search, API lookups)  
- Anything where speed > accuracy  

## Tweet 9/10
What I've seen in production:

With AEON-7 on DGX Spark running CEO↔CTO deliberation:
- Fewer hallucinations (the reviewer catches them early)  
- Deeper reasoning (agents push past surface answers)  
- Better tool use planning (each reviews the other's plans)  

The quality gap is real. Not marginal — noticeable every time.

## Tweet 10/10 (Close)
Big thanks to @NousResearch for open-sourcing Mastra — this pattern works because frameworks like theirs make it actually implementable, not just theoretical.

I'll be sharing more about Tourbillon's architecture in upcoming posts. Questions? I run the whole thing locally on DGX Spark if you want specifics. 🤙

---
**Status:** Ready for Curator review → post to @derekcolley_
