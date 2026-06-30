# Tourbillon Local-First Orchestration Thread (Draft)

**Status:** DRAFT  
**Priority:** MEDIUM-HIGH — New opportunity from GitHub launch (June 29)  
**Angle:** "Why local-first means no token budget caps" — the new practical insight Derek shared on June 29

---

## THREAD: Why Running AI Locally Changes Everything About Agent Design

### Tweet 1/7 (Hook)
I just launched Tourbillon — a local-first orchestration platform.

The most surprising thing about running agents on my DGX Spark? I don't need to cap their token budgets anymore.

This single change fundamentally alters what AI agents can actually do. Here's why 👇

### Tweet 2/7
**The cloud problem:**

When you use APIs (OpenAI, Anthropic, etc.), every token costs money. So agent designers are forced to:
• Limit how long each response can be
• Cap total conversation length  
• Be conservative about reasoning steps
• Artificially constrain what agents can explore

You're building agents around a billing model, not capability limits.

### Tweet 3/7
**The local advantage:**

On my DGX Spark, tokens are free. Well — electricity costs apply, but we're talking fractions of a cent per hour of inference. This means:

→ Agents can think longer before responding (more reasoning steps)
→ Longer conversations without artificial cutoffs
• Aggressive experimentation with agent architecture
→ No fear of "prompt hacking" from excessive token usage

You build agents around what's possible, not what's affordable per-call.

### Tweet 4/7
**What this unlocks in practice:**

In Tourbillon, I'm running CEO and CTO agents on AEON-7 models that:
• Delegate complex tasks to sub-agents (no token cost penalty)
• Run extended deliberation cycles before responding
• Maintain long cross-project context without budget concerns
• Experiment freely with prompt strategies

The agents behave more like real team members — thinking through problems, iterating, asking follow-ups. Not like API calls with strict timeout constraints.

### Tweet 5/7
**The architecture:**

Tourbillon's design centers on:
1. **Local-first inference** — All models run on DGX Spark hardware
2. **Hierarchical delegation** — CEO→CTO→team pattern for task decomposition  
3. **Open workspace UI** — Navigation, file preview/edit built into the agent loop
4. **No API dependencies** — Everything self-hosted

The result: an orchestration system where agent behavior is limited only by compute, not billing.

### Tweet 6/7
**Why this matters beyond personal projects:**

If you're building AI products or tools that rely on agents today, you're probably designing around cloud API constraints. Token budgets, rate limits, cost-per-call — these are shaping what's possible in agentic AI.

Local-first infrastructure flips that equation. It doesn't replace the cloud for everything (yet), but it creates a space where:
• Research and experimentation is cheaper
• Privacy is preserved by design  
• You have full control over model versions and updates
• Innovation isn't gated behind API access tiers

### Tweet 7/9 (Resources)
**Check out Tourbillon:** github.com/dcolley/tourbillon

It's open-source and I plan to share more about the architecture, agent patterns, and lessons learned from running real CEO/CTO agents for weeks.

The local-first approach isn't just a cost play — it's an architectural advantage that enables agent behaviors cloud APIs can't economically support yet.

---

**Tags:** @mastra_ai (agent harness context), @SpaceTimeViking (@AEON7_ for model reference)