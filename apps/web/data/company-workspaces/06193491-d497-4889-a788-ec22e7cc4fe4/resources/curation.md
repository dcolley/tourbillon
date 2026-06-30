# Curation: Themes & Ideas for @derekcolley_

**Last updated:** 2026-06-29 (XP-3 Research Integration)
**Curator:** Curator (designer)
**Source:** Derek's recent feed + topic trending analysis (via Nitter)

---

## Active Content Themes

### Theme 1: MoA / Council of Agents Tutorial — **URGENT/IMMEDIATE PUBLISH**
**Status:** 🔄 REVISION IN PROGRESS — Draft v1 submitted by Author on June 29. Curator review returned with 7 revision requirements (voice mismatch, missing data points, abstract code block, weak hook). Reassigned to Author for rewrite. Still overdue — promised June 30, now July 15+.

**Context from Derek's feed (June 27):**
- Replied to @NousResearch: "Sweet!! Looking forward to using this."
- Explicitly stated MoA is a "well known pattern for averaging / merging agent thoughts and responses"
- Committed to tutorial: "I'll be sharing a tutorial showing you how to do this in your project later this next week."

**Content ideas:**
1. **THREAD (primary deliverable): "How to implement a Council of Agents (MoA) pattern"** — step-by-step guide covering: what MoA is, why it improves agent outputs, practical implementation with Mastra or custom harness, real example from Derek's Tourbillon experience (CEO/CTO agents merging thoughts). Tag @NousResearch and relevant agent framework accounts.
2. **Supporting thread:** "Why your single agent isn't enough — the case for multi-agent deliberation" — frame it as a practical upgrade path: one agent makes decisions, but multiple agents reviewing each other's work produces better results. Use Tourbillon CEO→CTO→team pattern as proof point.

**Curator feedback on v1 (June 29):**
- Voice too polished/corporate — must match Derek's casual style (lowercase-heavy, "My AI reports:", etc.)
- Missing concrete data from Tourbillon (latency numbers, tok/s, specific examples)
- Abstract code block replaced with actionable config or real workflow example needed
- Hook tweet needs to be stronger and more personal
- Production observations need specific scenarios/examples
- Consider connecting to Ornith FP8 self-verification as bonus insight

**Angle:** This is Derek's own promised content. The tutorial should be hands-on — not theoretical. He has real experience running this in Tourbillon with AEON-7 models. **This is the highest-priority item on the entire curation list.**

---

### Theme 2: Nemotron 3 Ultra — NVIDIA's Open 550B MoE for Agentic Work
**Status:** 🔥 NEW TREND — @sudoingX just ran it June 28-29. Derek has NOT posted about this yet. High relevance to local AI/DGX Spark audience.

**Context from trending data (June 28-29):**
- **Nemotron 3 Ultra**: 550B total, 55B active MoE — NVIDIA's biggest in-house model
- Hybrid mamba-transformer architecture built specifically for long-running agentic workflows (coding/research that goes hours)
- NVFP4 quant available on HuggingFace: "barely moves off full bf16 accuracy" — needs ~4-6 DGX Sparks to run locally
- @sudoingX praised NVIDIA's open data + free NIM access while noting big labs are gatekeeping harder every quarter
- Derek already runs DGX Sparks and posts about multi-Spark setups — this is a natural fit

**Content ideas:**
1. **Thread: "NVIDIA just released the biggest local AI model they've ever made — and it's built for agents"** — cover Nemotron 3 Ultra specs, why NVIDIA going fully open (weights + free NIM access) matters compared to OpenAI/Anthropic closure, practical implications for who can run it (4-6 DGX Sparks). Tag @NVIDIAAI.
2. **Thread: "The 550B MoE question: Can Derek's DGX Spark tower handle Nemotron?"** — speculative but engaging. Calculate VRAM needed vs what he actually owns. Could be a fun engagement thread that sets up a future benchmark if/when hardware scales.

**Angle:** Derek has credibility as a local AI hardware person with multiple DGX Sparks. This is NVIDIA's own open model — directly aligned with his "open source must win" philosophy. The fact that it's built for agentic workflows (not just chat) connects to Tourbillon.

---

### Theme 3: Ornith 35B MoE — The "Sleeping Giant" Thread
**Status:** High priority — Derek already posted benchmarks, but the full story hasn't been told yet. @sudoingX's quant cheat sheet (June 28) amplifies this topic's relevance.

**Context from Derek's feed (June 27):**
- Ran Q4_K_M at ~78 tok/s on llama.cpp (fast prefill)
- Swapped to FP8 in vLLM: near-lossless quality, 3M token context, ~36 tok/s unoptimized baseline
- Key observation: FP8 version does **self-verifying tool use** — plans, checks, corrects. Q4 just fires and runs with whatever comes back. "Precision is visibly buying you intelligence"
- Scaffold-RL training approach: model learns task structure (scaffold) alongside code generation

@sudoingX's quant cheat sheet (June 28):
- Clear framework: Q4_K_M → Q5/Q6 → Q8_0/FP8 → bf16/fp16
- "Precision isn't just cleaner text, it buys reasoning. Pick your quant for the job, not the hype."
- Cites his own Ornith 35B runs as proof

**Content ideas:**
1. **Thread: "A 35B agentic coding model at near-full precision on a desk"** — the FP8 + vLLM story with tok/s numbers, context window comparison vs Q4, and the self-verification behavior as proof that quantization quality matters for agent workloads. This is the thread Derek said people are "sleeping on."
2. **Article: "Why Ornith's scaffold-RL is different from coding RL"** — explain how most coding models only optimize final code output; Ornith optimizes the planning structure too. Use Derek's observation of watching it double-check tool calls. Tie to Tourbillon use case.

**Angle:** Derek has positioned himself as one of the few who actually ran it at FP8 and observed agent behavior — not just benchmark scores. The MoA tutorial being next week could naturally connect: "Here's how our agents work, and here's why Ornith is a great model for that pattern."

---

### Theme 4: Tourbillon Local-First Orchestration
**Status:** Active development — NEW angle from June 29 tweet promoting GitHub repo + no token budget caps. XP-25 created for community feedback request.

**Context from Derek's feed (June 29):**
- **New:** "Tourbillon is a local-first orchestration platform. By running local agents on DGX Spark, I don't need to cap my agent's token budget..! 🚀" + github.com/dcolley/tourbillon
- June 27: Tourbillon workspace UI updated (navigation fixed, file preview/edit)
- June 26: CEO/CTO agents running on AEON-7 models, both DGX servers "grinding out tokens"

**Content ideas:**
1. **Thread: "Why local-first means no token budget caps"** — the new angle from Derek's June 29 tweet. Cloud APIs charge per token, so you cap budgets. On a DGX Spark at home, tokens are free (electricity only). This changes agent design fundamentally. Practical implications for what agents can actually do — longer reasoning chains, more tool calls, deeper investigation without cost anxiety.
2. **Thread: "Tourbillon architecture deep-dive"** — how the CEO→CTO→team delegation pattern works. AEON-7 models as backbone. How cross-company memory (Cognee interest) could fit in. Reference June 26 Cognee reply where Derek said "Would love to plug this into Tourbillon."
3. **XP-25: Community Feedback Request** — Post asking users what features they want next, benchmarking priorities, and use cases. Builds community + gathers research for future content. Link to github.com/dcolley/tourbillon.

**Angle:** The GitHub repo launch is new and significant. This is Derek's own product/platform being promoted. Content should help others understand and potentially use it. Practical > promotional.

---

### Theme 5: GGUF Conversion Quality Wars
**Status:** Active research — Derek posted benchmark comparison in progress (June 26). Still unresolved. XP-5 research covering Heretic vs knoopx findings will provide fresh data here.

**Context from Derek's feed (June 26):**
- Heretic local GGUF underperforms knoopx/RedHatAI converter by ~5× perplexity and ~3× throughput
- Same hardware, same llama-bench flags, same NVFP4 file type — the difference is purely in the conversion pipeline

**Content ideas:**
1. **Thread (when benchmark finishes): "GGUF conversion quality matters more than you think"** — publish full comparison. Frame as: "Same model, same quant format, different converter = massive quality gap." Practical advice for anyone running local models.
2. **Article: "The hidden variable in local AI benchmarks"** — why two GGUF files from the same base model produce completely different results. Explain what converters do differently, how to verify conversion quality before trusting benchmark claims.

**Angle:** Derek's authority comes from actually bench-running the comparison himself. This is practical content that addresses a real pain point for anyone running local models.

---

### Theme 6: MTP / Speculative Decoding — The Local AI Speed Revolution
**Status:** 🔥 HIGH PRIORITY — XP-19 created for Author to run DGX Spark benchmarks. @ggerganov endorsed MTP as "significant milestone."

**Context from trending data + Derek's feed (XP-3 research):**
- RTX 5060 Ti: Qwen3.6-35B-A3B went from **98 t/s to 144 t/s (+47%)** with MTP draft-2
- RTX 3090: Mixed/no improvement (A3B MoE has less "idle" compute to trade)
- vLLM showed **+27.5% faster decode rate** with MTP k=1 (N=5 trials)
- SpaceTimeViking's DFlash technique: **200-300% over stock** on Ornith models
- Qwen3.6-27B AEON Ultimate completed puzzle in 15s vs 130s stock (**8.7x improvement**)

**Key Technical Context:**
- The 35B-A3B model has 35B total params but only ~3B active per token — baseline decoding is already cheap, so speculative decoding gains are smaller/variable on MoE models
- Key flags: `--spec-type draft-mtp --spec-draft-n-max 2`

**Content ideas:**
1. **XP-19: "MTP Speculative Decoding on DGX Spark" Benchmark Thread** — Derek runs his own benchmarks with Qwen3.6-35B-A3B-MTP GGUF (ggml-org). Compare against RTX 3090 data (no improvement) vs RTX 5060 Ti data (+47%). Position as authority on speculative decoding for MoE models.
2. **Thread: "Why KV cache quantization is more important than model size"** — explain how fp8_e4m3 or q4_0 KV caches let you run 262K context on cards that can't fit the raw weights. This is a knowledge gap most local AI users don't have.

**Angle:** Derek has hands-on experience with both llama.cpp and vLLM, plus he runs DGX Sparks daily. He can bridge the gap between cutting-edge research and what works on real desk setups. **XP-19 created for this.**

---

### Theme 7: Decentralised AI Infrastructure
**Status:** 🔥 HIGH PRIORITY (URGENT) — XP-24 created for Author to cover Chronara + Pluralis Agora. June 30 deadline for Chronara.

**Context from Derek's feed + XP-3 research:**
- RT'd "Decentralised inference network" to @sudoingX (June 28)
- June 26: Strong belief that decentralized inference is an Uber-like moment
- Topics.md notes active interest in sparkl-network and Pluralis Agora
- **URGENT:** Chronara AI public airdrop closing June 30, 2026

**Key Topics for XP-24:**
1. **Chronara AI** (urgent) — public airdrop closing, decentralized compute network entering commercial phase. Link: https://chronara.io/news
2. **Pluralis Agora** — Protocol Learning for decentralized model-parallel training. @jbrukh tweeted June 13 that it's "the only true counterbalance to centralized AI." Documentation: https://pluralis.ai/docs/
3. **Broader ecosystem context** — Akash Network, sparkl-network as reference points

**Content ideas:**
1. **XP-24: "Decentralized Compute Networks Roundup"** — Post about Chronara deadline (urgent), then broaden to Pluralis Agora and the broader decentralized compute ecosystem. Connect to Derek's "open source must win" philosophy and @jun_song's advocacy.
2. **Thread: "Why 'open source must win' isn't just ideology — it's infrastructure"** — connect the dots between open-weight models being fragile (could get closed at any moment) and why we need decentralized training, inference networks, and community-owned datasets.

**Angle:** This is the philosophical/strategic content that gives Derek's account depth beyond benchmarks and model reviews. **XP-24 created for this.**

---

### Theme 8: Cognee Integration / Long-Context Memory for Agents
**Status:** NEW — Derek explicitly expressed interest (June 26 reply to @tricalt).

**Context from Derek's feed (June 26):**
- Replied to Cognee v1.0 announcement: "Would love to plug this into Tourbillon - cross-company memory of all projects, goals, tasks"
- Community note flagged unverified claims in Cognee marketing ("145% better than Opus," etc.)

**Content ideas:**
1. **Thread: "What I want from long-context memory for agents"** — Derek's specific use case: Tourbillon agents that remember cross-company context (projects, goals, tasks). Frame it around his actual needs rather than Cognee's marketing claims. Be skeptical of the 145% claim but genuine about wanting the capability.
2. **Thread: "The memory problem in agent systems — and why most solutions miss it"** — practical take on what agents actually forget vs what they don't need to remember. Connect to Tourbillon's real workflow needs.

**Angle:** Derek has a concrete use case (cross-company memory for Tourbillon) that makes this more interesting than generic "agents forget things" content. He's pragmatic and skeptical of marketing claims — keep it honest.

---

### Theme 9: NVIDIA Open Model Strategy & DGX Spark Community
**Status:** 🔥 TRENDING — @sudoingX's Nemotron coverage + "Dear @NVIDIAAI, if you have a spare DGX Station GB300 for us model crunchers" retweet by Derek (June 25).

**Context from trending data (June 25-29):**
- Derek retweeted plea for DGX Station GB300 with "Asking for a friend... ;)" — shows humor around hardware desires
- @sudoingX: NVIDIA set up free NIM access, open weights, open data — "while the big labs gatekeep harder every quarter, nvidia quietly became one of the most open players in AI"
- Nemotron 3 Ultra NVFP4 quant available on HuggingFace for local run (~4-6 DGX Sparks needed)

**Content ideas:**
1. **Thread: "NVIDIA's unexpected role as the champion of open AI"** — contrast NVIDIA's free model access, open weights, and community tooling against OpenAI/Anthropic/Meta's tightening gates. Derek has hardware + philosophy to make this authentic. Tag @NVIDIAAI.
2. **"Asking for a friend" thread: The DGX Spark → DGX Station GB300 upgrade path** — humorous but informative. What can you run on 1-4 Sparks vs what a GB300 unlocks. Connect to Nemotron 3 Ultra as the "if we get there" model.

---

### Theme 10: Hermes Agent Ecosystem Momentum
**Status:** NEW TREND — @sudoingX is heavily promoting Hermes Agent (from NousResearch) as THE entry point for local AI. Multiple users migrating from OpenClaw to Hermes.

**Context from trending data (June 28-29):**
- @sudoingX: "Hermes agent everywhere" — multiple users leaving OpenClaw for Hermes
- Beautiful new web UI with Ornith FP8 at near-lossless on single DGX Spark
- "if you're getting into local AI or agentic developments, hermes agent is the leanest door in. stands up in seconds, no onboarding maze."

**Content ideas:**
1. **Thread: "What Derek's Tourbillon agents look like running on Hermes vs custom harness"** — comparison angle. Derek runs CEO/CTO agents on AEON-7. How would that stack compare to Ornith on Hermes? Practical evaluation thread.
2. **Thread: "The local AI dashboard war: OpenClaw → Hermes migration wave"** — why users are switching, what matters in a UI for agent work (session management, tool call visibility, log inspection). Derek can evaluate from the Tourbillon perspective.

---

### Theme 11: Polkadot Staking Reform
**Status:** NEW — Derek posted about Polkadot staking disruption on June 29 (first non-AI content in days).

**Context from Derek's feed (June 29):**
- Polkadot referenda 1909: All validator commission now 0%, requires min 10K DOT self-stake, no nominator commissions
- Rewards based on own stake only

**Content ideas:**
1. **Tweet/Thread: "Polkadot just changed the staking game"** — explain what ref 1909 means for validators and nominators. Frame as a major shift in DeFi/crypto governance. Derek's crypto/blockchain background gives him authority here.

---

### Theme 12: Hardware & Model Crunching Culture
**Status:** Evergreen — DGX Spark collection, power draw, cooling, earlyoom protection. NEW angle from "memory ownership flex" trend.

**Context from trending data (June 28):**
- @sudoingX posted "how much memory do you actually own" flex: 448GB across devices
- Derek's retweet of DGX Station GB300 request ("Asking for a friend")
- Derek already has multi-DGX Spark setup

**Content ideas:**
1. **Thread: "What I actually spend on running local AI at scale"** — power draw per DGX Spark, cooling costs, electricity, total TCO for a 3-Spark setup vs cloud API costs. Numbers-only format, very practical.
2. **Thread: "DGX Spark as a gateway drug"** — lean into the humor. The progression from 1 Spark to N Sparks. Earlyoom crashes, thermal throttling, building towers of compute. Keep it self-deprecating and fun.

---

### Theme 13: Physical Engineering / Steampunk
**Status:** Light interest but high engagement potential — steam-powered bike retweet got engagement ("Ultra #steampunk!").

**Content ideas:**
- Steam-powered engineering appreciation posts that align with mechanical creativity + tech passion. Keep brief and genuine.
- Retweet @oomwoo open-source robot vacuum (ROS2 + Raspberry Pi) — ties to Derek's steampunk/physical engineering interest + local AI philosophy.

---

### Theme 14: X Platform Toxicity & Algorithm Reform
**Status:** Medium — Karpathy/X toxicity thread retweeted by Derek (June 26), @sudoingX wrote long piece on staying on X for growth.

**Content ideas:**
1. **Thread: "Why I stay on X when it's toxic"** — personal take from Derek's perspective as someone building in public with hardware/AI content. What's the payoff vs the pile-on? Connect to Musk's algorithm overhaul promise.
2. **Thread: "Building in public as a hardware person"** — what it means to share your setup, benchmarks, failures (OOM crashes) publicly. The audience you build and how it opens doors.

---

## New Issues Created from XP-3 Research (June 29)

| Issue ID | Title | Priority | Status | Notes |
|----------|-------|----------|--------|-------|
| **XP-19** | MTP Speculative Decoding Benchmark on DGX Spark | HIGH | todo | Derek should run benchmarks with Qwen3.6-35B-A3B-MTP GGUF |
| **XP-24** | Decentralized AI Compute Networks Roundup (Chronara + Pluralis) | HIGH | todo | URGENT: Chronara deadline June 30 |
| **XP-25** | Tourbillon Community Feedback Request | MEDIUM | todo | Ask users what features they want next after GitHub launch |

---

## Trending Topics Worth Monitoring (Updated June 29)

| Topic | Relevance | Action | Status |
|-------|-----------|--------|--------|
| **MoA / Council of Agents tutorial** | **CRITICAL — OVERDUE** | Revision in progress. Draft v1 sent back to Author for rewrite. Still needs posting. | 🔄 REVISION IN PROGRESS (XP-9) |
| **MTP Speculative Decoding Benchmark** | 🔥 HIGH — Fresh trend, XP-19 created | Derek should run DGX Spark benchmarks with Qwen3.6-35B-A3B-MTP | ✅ ISSUE CREATED (XP-19) |
| **Decentralized AI Compute (Chronara + Pluralis)** | 🔥 HIGH/URGENT — June 30 deadline, XP-24 created | Post about Chronara airdrop closing + broader ecosystem analysis | ✅ ISSUE CREATED (XP-24) |
| **Tourbillon Community Feedback** | MEDIUM — New angle post-GitHub launch, XP-25 created | Ask community what features they want next for Tourbillon | ✅ ISSUE CREATED (XP-25) |
| Nemotron 3 Ultra (NVIDIA open 550B MoE) | Very High | New trend from @sudoingX, Derek hasn't covered yet. Perfect for DGX Spark audience. | 🔥 NEW OPPORTUNITY |
| GGUF converter quality debates | High | Follow up on XP-5 research findings when ready. | In progress |
| Ornith FP8 self-verification behavior | Very High | Core theme — Derek has unique observation about precision buying intelligence. | Active |
| Hermes Agent ecosystem momentum | Medium-High | Migration wave from OpenClaw to Hermes. Derek can compare vs Tourbillon/AEON-7 stack. | Trending |
| Polkadot staking reform (ref 1909) | Low-Medium | First non-AI post in days. Short thread explaining the change. | Light content |

---

## Content Cadence Suggestions

Based on Derek's posting patterns:
- **Benchmarks/results tweets:** 1-2 per week (highest engagement)
- **Agent system updates:** 1 per 1-2 weeks
- **Educational threads (MoA, MTP, etc.):** 1 per 1-2 weeks
- **Retweets with commentary:** daily or near-daily
- **Humor/personality posts:** occasional ("asking for a friend," "shiny new thing... meh")

---

## Topics to Avoid (per style guide)

1. Major closed-model hype without local/open alternatives — Derek dismisses these as "meh"
2. Cloud-only AI solutions — audience wants local/on-prem
3. Theoretical discussions without practical application
4. Corporate AI announcements that lack open-weight/local options
5. Over-hyping products with unverified claims (e.g., Cognee's marketing claims flagged by community note)

---

## Cross-Topic Connections (Content Synergy)

| Topic A | + Topic B = Content Angle |
|---------|--------------------------|
| **MoA Tutorial** + Ornith 35B MoE | "How I'd use a Council of Agents with Ornith FP8" — practical combo of both themes |
| Tourbillon + MTP/Spec Decode (XP-19) | "Optimizing Tourbillon agents with speculative decoding" — how speed gains affect agent workflows |
| **Tourbillon GitHub** + Decentralised AI (XP-24) | "Could Tourbillon agents run on decentralized compute?" — future-looking, ties into sparkl-network interest |
| GGUF Quality + Hardware Culture | "Your converter is costing you 3× throughput" — ties into community's obsession with benchmark numbers |
| Privacy + Local AI | "Local models = your prompts stay yours" — principled take on why Derek runs everything on desk hardware |
| **Nemotron 3 Ultra** + MoA Tutorial | "550B model, local-first, running through multi-agent orchestration" — the ultimate combo post if hardware scales up |

---

## Priority Queue (Next Content to Produce)

1. **MoA Tutorial Thread** 🚨 — Derek promised this on June 27 for "next week." It's been 30+ days. Draft v1 sent back for revision. XP-9 in_progress with Author.
2. **MTP Benchmark (XP-19)** 🔥 — Run DGX Spark benchmarks of Qwen3.6-35B-A3B-MTP GGUF. Fresh trending content matching Theme 6.
3. **Decentralized Compute Roundup (XP-24)** 🔥🔥 URGENT — Chronara AI airdrop closing June 30. Post immediately then broaden to ecosystem analysis.
4. **Tourbillon Community Feedback (XP-25)** — Ask users what features they want next after GitHub launch. Builds community + research for future content.
5. **Nemotron 3 Ultra Overview Thread** 🔥 — Fresh trend, nobody in Derek's orbit has covered it yet. High engagement potential with DGX Spark audience.
