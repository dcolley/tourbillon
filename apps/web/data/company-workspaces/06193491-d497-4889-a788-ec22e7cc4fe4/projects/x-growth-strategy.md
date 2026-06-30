# X Growth Strategy — @derekcolley_

**Created:** 2026-06-30  
**Curator:** Curator (designer)  
**Status:** Draft v1.0  

---

## Executive Summary

Derek Colley has built genuine authority in the local AI / DGX Spark community through hands-on benchmarking, agent system development (Tourbillon), and a distinctive voice that blends technical depth with self-deprecating humor. The growth strategy below focuses on **systematizing what already works** while adding structure for consistent follower acquisition — without sacrificing authenticity.

### Current Position
- **Content authority:** High — one of the few people actually running Ornith FP8, comparing GGUF converters, building multi-agent systems on desk hardware
- **Posting pattern:** Irregular bursts (benchmarks → quiet periods). Needs more consistent cadence.
- **Engagement style:** Heavy retweets with occasional commentary; original threads are high-value but infrequent
- **Audience overlap:** Local AI builders, GGUF community, agent developers, decentralized compute enthusiasts

### Growth Objectives (90-Day)
1. **Follower growth:** 25–40% increase through consistent high-signal content + strategic engagement
2. **Thread performance:** Each educational thread hits 3K+ impressions and 50+ engagements
3. **Community authority:** Become the go-to reference for "what actually works on DGX Spark / local AI desk setups"

---

## Content Pillars (What to Post About)

Based on Derek's existing themes, we consolidate into four pillars with specific content types:

### Pillar 1: Benchmarks & Hardware — "Run It Yourself"
**Content types:** Benchmark results, tok/s comparisons, hardware tips, OOM crash reports  
**Cadence:** 2–3 per week  
**Why it works:** This is Derek's superpower. Nobody else publishes real numbers from desk-side DGX Sparks. Every benchmark tweet gets engagement because it's **data other builders need.**

**Content ideas:**
- "Benchmarked Qwen 35B-MoE on 1x vs 2x DGX Spark — here are the real differences"
- "GGUF converter quality matters more than quant format (my benchmarks)"
- "What actually fits on a single DGX Spark in July 2026 [model list with tok/s]"
- OOM crash post-mortems: "Here's what killed my Spark this morning and how I fixed it"

### Pillar 2: Agent Systems — "Tourbillon Behind the Scenes"
**Content types:** How agent delegation works, real examples of CEO→CTO tasks, lessons learned  
**Cadence:** 1 per week  
**Why it works:** Multi-agent systems are hot but most people theorize. Derek is **actually running them.** The gap between theory and practice is where authority lives.

**Content ideas:**
- Thread: "How our CEO agent delegates work to CTO agents (real example from Tourbillon)"
- Thread: "What happens when your AI agents actually work — including the failures"
- Thread: "MoA / Council of Agents — how we're building it in Tourbillon" *(Derek's promised thread)*
- Post: "Why AEON-7 models for agent delegation (and what I'd change)"

### Pillar 3: Education & How-To — "Two Flags, Double Speed"
**Content types:** MTP/speculative decoding guides, GGUF quality explainers, model selection advice  
**Cadence:** 1 thread per week  
**Why it works:** Derek can bridge cutting-edge research (MTP, scaffold-RL) and desk reality. This content gets **evergreen engagement** — people find it months later via search.

**Content ideas:**
- Thread: "Two flags for nearly double speed — MTP for local AI (step-by-step)"
- Thread: "Why your GGUF converter is costing you 3× throughput"
- Thread: "Speculative decoding on DGX Spark: what works, what doesn't"
- Article: "The complete guide to running a 35B model locally in July 2026"

### Pillar 4: Community & Culture — "The Spark Collector's Journal"
**Content types:** Humor posts ("asking for a friend"), steampunk appreciation, opinion takes on open source  
**Cadence:** Daily retweets with commentary + 1–2 personality posts per week  
**Why it works:** This is what makes Derek **a person**, not just an AI account. The humor and genuine enthusiasm are what make people follow him rather than just bookmarking his benchmarks.

**Content ideas:**
- "Asking for a friend" hardware jokes (proven format)
- Steam-powered engineering retweets with brief appreciation comments
- Opinion threads on open source vs closed AI, platform toxicity
- Retweets of @sudoingX, @jun_song, @SpaceTimeViking with genuine commentary

---

## Posting Cadence (Target Weekly Schedule)

| Day | Content Type | Example |
|-----|-------------|---------|
| **Mon** | Benchmark / hardware result | New benchmark numbers or comparison |
| **Tue** | Retweets + commentary daily, 1 educational thread | MTP guide, GGUF quality explainer |
| **Wed** | Agent system update or "behind the scenes" | Tourbillon progress, MoA thread |
| **Thu** | Retweets + commentary, opinion/philosophy post | Open source take, platform discussion |
| **Fri** | Benchmark OR hardware humor post | Results OR "asking for a friend" joke |
| **Sat** | Light day — retweets with personality comments | Steampunk, community engagement |
| **Sun** | Planning / reflection — occasional thread prep tweet | "Working on a thread about X this week..." |

### Minimum Viable Cadence (if Derek is busy)
- **3 original tweets per week minimum** (1 benchmark + 1 agent/educational + 1 personality/humor)
- **Daily retweets with brief commentary** (5–10 seconds each, adds value or humor)
- **1 thread per week** (highest impact content type)

---

## Engagement Strategy (How to Grow Beyond Your Own Posts)

### Reply Strategy — The "Add Value, Not Noise" Rule
Derek's replies should:
1. **Expand the original point** with a number, observation, or correction
2. **Reference Derek's own experience** ("I bench-ran this on DGX Spark and got different numbers because...")
3. **Ask genuine questions** to start conversations (not engagement bait)

### Accounts to Engage With Weekly
- **@sudoingX** — Ornith/DGX Spark benchmarks (high overlap, natural ally)
- **@jun_song** — Decentralized AI / open source advocacy
- **@SpaceTimeViking** — AEON-7 models, Tourbillon ecosystem
- **@ggerganov / @mishig25** — GGUF/llama.cpp community (authority signal)
- **@UnslothAI** — Model quantization tools
- **@mastra_ai (Traverse)** — Agent framework

### Reply Templates (Adapt, Don't Copy-Paste)
1. **Benchmark reply:** "Interesting numbers. I bench-ran [same model] on DGX Spark and got [X] tok/s with [config]. The gap is likely [reason]."
2. **Agent architecture reply:** "We're doing something similar in Tourbillon — agent harness with observational memory, but we use [AEON-7/Mastra/etc]. Key difference: [insight]."
3. **Hardware discussion reply:** "Running this on Spark right now. The limiting factor is actually [VRAM/bandwidth/cooling], not [what they said]. Here's what I measured..."

---

## Content Formats That Drive Growth

### Format 1: Benchmark Comparison Thread (Highest Impact)
```
Hook: "[Model A] vs [Model B] on DGX Spark — I ran both and the winner surprised me"
↓
Context: Why this comparison matters, test conditions
↓
Results table with tok/s, quant format, hardware config
↓
Key takeaway: What this means for someone building locally
↓
Resources: Links to models, configs, full benchmark data
```

### Format 2: "Here's How I..." Thread (Evergreen)
```
Hook: "How I run a 35B agentic coding model on my desk — step by step"
↓
Hardware setup (DGX Spark specs)
↓
Model selection and why
↓
Quantization choice (NVFP4 vs FP8, etc.)
↓
Engine config (vLLM vs llama.cpp)
↓
Real-world results and lessons learned
↓
Links to resources used
```

### Format 3: Opinion Thread with Data Backing
```
Hook: "Here's why local AI is winning and nobody's talking about it"
↓
3–5 data points that support the claim
↓
Counter-argument + response (shows intellectual honesty)
↓
What you should do next (actionable takeaway)
```

### Format 4: The "Asking for a Friend" Humor Post
```
Format: Short, self-deprecating, hardware-adjacent joke
Example: "Dear @NVIDIAAI — if you have a spare DGX Station GB300... asking for a friend. ;)"
```

---

## Growth Levers (What Will Actually Move the Needle)

### Lever 1: Become the DGX Spark Benchmark Authority
**Action:** Publish one definitive benchmark comparison per week. Always include: model name, quant format, hardware config, tok/s numbers, engine used.  
**Why it works:** Builders search for these numbers. When they find Derek's thread, they follow because he's **the person who knows.**

### Lever 2: The MoA / Council of Agents Thread (Derek's Promised Content)
**Action:** This is the highest-priority content item. Derek already teased it on June 27 — capitalize on that anticipation.  
**Why it works:** Multi-agent orchestration is a hot topic with very few practical examples from real builders.

### Lever 3: Engage in Hot Conversations Early
**Action:** When trending topics hit local AI (new GGUF format, new model release, benchmark debate), Derek should reply within hours — not days — with his hands-on perspective.  
**Why it works:** Early replies on hot threads get visibility from people who didn't know Derek existed.

### Lever 4: Cross-Pollinate Communities
**Action:** Share benchmark results in GGUF Discord channels, llama.cpp forums, and local AI subreddits with links back to X threads.  
**Why it works:** Brings builders from other platforms into Derek's X audience.

---

## Measurement & Iteration

### Weekly Metrics to Track
1. **Follower count** — target 25–40% growth over 90 days
2. **Thread impressions** — aim for 3K+ per thread, track which topics perform best
3. **Engagement rate** — (likes + replies + RTs) / impressions; benchmark > 3%
4. **Profile visits from impressions** — indicates content is compelling enough to make people check the profile

### Monthly Review Questions
- Which content pillar got the most engagement? Double down on it.
- Which thread had the highest follower conversion? Analyze why.
- What topics did Derek's audience respond to that weren't planned? Add to curation doc.
- Are replies getting more visibility than original posts? Adjust posting ratio.

---

## Quick Wins (Do These This Week)

1. **Publish the MoA / Council of Agents thread** — Derek already teased it, build anticipation
2. **Finalize and publish the GGUF converter benchmark article** — finish what he started
3. **Engage with 5–10 hot threads in local AI space** — reply with hands-on perspective
4. **Pin a "who I am / what this account is about" thread** — new visitors need context
5. **Create a curation calendar for next week** — pre-plan 3 original posts + daily retweet targets

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Posting feels inauthentic / "content farm" vibe | Derek writes everything himself; no AI-generated tweets. Strategy is a guide, not a script. |
| Over-posting reduces quality | Weekly cadence has flex room — 1 high-quality thread beats 3 mediocre ones |
| Engagement bait backfires | All engagement must add genuine value or humor — never "follow for part 2" style content |
| Burnout from consistency pressure | Minimum viable cadence is 3 original tweets/week + daily retweets. Derek can scale up when energy allows |

---

## Appendix: Content Pipeline (Next 2 Weeks)

### Week 1
- **Mon:** Benchmark thread — Ornith FP8 on DGX Spark (self-verifying tool use results)
- **Tue:** Educational thread — MTP speculative decoding explained for local AI builders
- **Wed:** Agent update — Tourbillon progress + MoA thread start
- **Thu:** Opinion post — "Why I think open source AI needs a rallying point in 2026"
- **Fri:** Benchmark OR humor post (Derek's call)
- **Weekend:** Retweets with commentary, community engagement

### Week 2
- **Mon:** GGUF converter benchmark results article (finish Derek's ongoing work)
- **Tue:** How-to thread — "Running a 35B agent model on DGX Spark: full setup guide"
- **Wed:** Agent thread — real CEO→CTO delegation example from Tourbillon
- **Thu:** Retweets + commentary, engage with trending local AI topics
- **Fri:** Hardware humor / personality post
- **Weekend:** Light engagement, plan week 3

---

*This is a living document. Update curation.md weekly with new ideas from Derek's feed and trending analysis.*