# Research Summary: MoA / Council of Agents Tutorial Content

**Issue:** XP-4 | **Priority:** Critical | **Date:** June 29, 2026

---

## Executive Summary

Derek Colley committed on Twitter to sharing a tutorial on building a MoA (Mixture of Agents) / "Council of Agents" system in his Tourbillon platform. This is the highest priority content piece — he built anticipation around it and it directly ties into his local-first AI orchestration work with AEON-7 models running on DGX Spark hardware.

---

## 1. Derek's Public Statements About MoA / Multi-Agent Architecture

### Key Tweets from @DerekColley_:

**Tourbillon Platform Announcements:**
- *"Toubillon is a local-first orchestration platform. By running local agents on DGX Spark, I don't need to cap my agent's token budget..! 🚀"* (June 29) → [Link](https://x.com/DerekColley_/status/2071566174907662598)
- *"Behind each Tourbillon agent, I plugged in new models from AEON-7. CEO and CTO delegating work for the rest of the team. Tasks are running smoothly"* (June 26) → [Link](https://x.com/DerekColley_/status/2070545368891212014)
- Tourbillon workspace UI update shared June 27 with navigation and file preview improvements

**DGX Spark / Local Agent Context:**
- Derek has been sharing extensive DGX Spark performance data — running massive models locally (DeepSeek V4 Flash REAP'd to 180B, Ornith 35B MoE at FP8)
- He's actively experimenting with agentic workflows using AEON-7 optimized models
- His approach: local-first, no cloud dependency, full hardware ownership

**Open Source AI Philosophy:**
- Derek shared Jun Song's "open source must win" post emphasizing agent loops & harnesses as critical infrastructure (June 26) → [Link](https://x.com/DerekColley_/status/2070540858236256448)

### The Promise to Build:
Derek has been building Tourbillon as a multi-agent orchestration platform. His "Council of Agents" concept involves CEO and CTO agents delegating work to specialized team members — essentially his own implementation of the MoA pattern he promised to teach.

---

## 2. Current State of the Art: NousResearch MoA / Mixture of Agents

### The Announcement (June 26, 2026)

**NousResearch launched Hermes Agent with MoA (Mixture of Agents):**
- **Claim:** 8% higher than Opus 4.8 and 11% higher than GPT 5.5 on their upcoming benchmark
- **How it works:** Reference models answer in parallel → aggregator reads responses → runs task, calling tools and repeating the loop as needed
- **Approach:** Not a new foundation model — orchestrates existing models (OpenRouter, local inference) into a stronger composite

**Key Sources:**
- NousResearch MoA Announcement: [Link](https://x.com/NousResearch/status/2070610321278988385)
- How-to Guide: https://actionableops.com/hermes-howto/mixture-of-agents
- Documentation: https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents#select-a-moa-preset-as-your-model

### Community Reactions (June 26-29)

**@Shaughnessy119:** *"The NousResearch mixture of agents feature is extremely compelling... You can also mix/match many cheaper open source models that are 1/10 to 1/100 the cost and achieve very good intelligence"* → [Link](https://x.com/Shaughnessy119/status/2071629695301394941)

**@CShorten30 (Weaviate):** *"This emerging sample-and-judge pattern is incredibly powerful. I also like Perplexity's Model Council as an example of this... OpenRouter is an interesting counterpoint — instead of sampling every model and judging, you route to the right one upfront"* → [Link](https://x.com/CShorten30/status/2071254841976897545)

**@HansCNelson:** *"Mixture of AGENTS (MoA)... A standardized framework for combining DIFFERENT MODELS from DIFFERENT LABS into one ultra powerful synthetic model. Think of it like the Voltron of AI models... there is no single throat to self-censor or choke by force"* → [Link](https://x.com/HansCNelson/status/2070877447357145260)

**@zhodonx:** *"Using a structure just like the LLM council by karpathy... Creates 'advisor' models to read along & pass private notes; giving no replies, or using tools. Then a 'lead' model reads everything; your message + every note; then does the work & answers"* → [Link](https://x.com/zhodonx/status/2070774202848755871)

### MoA 2.0 Updates
- Japanese community coverage (June 27): Hermes Agent v0.17.0 released with tool improvements and async sub-agents → [Link](https://x.com/DolphinRoadster/status/2071009676670689301)
- GitHub stars: 50,000+ community adoption

### Key Technical Detail — The Architecture Pattern:
```
User Request
    ↓
┌─────────────────────────────┐
│       Aggregator Model      │  (e.g., Opus 4.8)
│  - Reads user request        │
│  - Dispatches to advisors    │
│  - Collects & synthesizes    │
│    responses                 │
└──────────┬──────────────────┘
           ↓
┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐
│Adv1 │ │Adv2 │ │Adv3 │ │Adv4 │  (Reference models, parallel)
└─────┘ └─────┘ └─────┘ └─────┘
           ↓
    [Synthesis] → Tools → Loop as needed → Final Answer
```

### Comparison: Sample-and-Judge vs. Routing

| Approach | Cost | Quality | Speed | Use Case |
|----------|------|---------|-------|----------|
| **MoA (Sample & Judge)** | Higher (multiple models) | Best of breed | Slower (parallel calls) | Complex reasoning, hard tasks |
| **OpenRouter Routing** | Lower (one model) | Good | Fast | Predictable winner, simpler tasks |
| **Ensemble** | Medium | Strong | Medium | Complementary failure modes |

---

## 3. Derek's Approach vs. Other Implementations — Key Differentiators

### What Makes Derek's Tourbillon + AEON-7 Unique:

| Dimension | NousResearch MoA | Derek's Tourbillon |
|-----------|------------------|--------------------|
| **Inference** | Cloud/Remote (OpenRouter, hosted) | Fully Local (DGX Spark, Blackwell) |
| **Model Source** | Mix of frontier models (Opus, GPT-5.5, etc.) | AEON-7 optimized uncensored models |
| **Cost Model** | Per-token API costs | Hardware amortization ($100-$3k per DGX Spark) |
| **Orchestration** | Hermes Agent framework | Custom Tourbillon platform |
| **Agent Roles** | Advisor + Aggregator pattern | CEO/CTO delegation to specialized team agents |
| **Context Window** | Limited by API constraints | Uncapped — "don't need to cap agent's token budget" |
| **Privacy** | Data goes through Nous/OpenRouter | 100% local, no data leaves the machine |
| **Censorship** | Standard model filters | AEON-7 uncensored (abliterated) models |

### Derek's Unique Value Proposition:
1. **Local-first MoA:** Running mixture-of-agents entirely on DGX Spark hardware — zero cloud dependency, zero API costs per token
2. **Uncensored Council:** Using AEON-7 abliterated models means the "council" won't refuse any task — critical for creative/technical work
3. **Custom Agent Roles:** CEO/CTO delegation pattern is more sophisticated than simple advisor-aggregator — it's organizational, not just architectural
4. **Hardware Optimization:** Working with SpaceTimeViking on DFlash optimizations (200-300% performance over stock), NVFP4 quantization, Mamba Cache precision tuning

### Critical Context from the Community:
**@sudoingX** ran Ornith 35B MoE at FP8 (near lossless) through hermes agent and observed self-verification behavior — the model double-checked its own work mid-task. This is exactly the kind of agentic intelligence Derek would want in his "council." → [Link](https://x.com/sudoingX/status/2070931222084395207)

---

## 4. Relevant Threads from Key People

### @SpaceTimeViking (ÆON FORGE / AEON-7) — Derek's Model Partner
Derek has been actively engaging with SpaceTimeViking's work:
- **Ornith 1.0 AEON Ultimate Uncensored** release (June 27): BF16 + NVFP4 for DGX Spark/Blackwell, DFlash working → [Link](https://x.com/SpaceTimeViking/status/2070987934841368929)
- **Qwen3.6-27B AEON Ultimate:** 15 seconds vs 130 seconds on stock for complex puzzles → [Link](https://x.com/SpaceTimeViking/status/2070262583852970162)
- **Abliteration research:** "Somehow my Abliterated Qwen-27B model scores higher than a 310B parameter model" → [Link](https://x.com/SpaceTimeViking/status/2069165138511290442)
- **Community benchmarking:** Building comprehensive leaderboard for DGX Spark performance → [Link](https://x.com/SpaceTimeViking/status/2070932260207886720)

### @sudoingX — Local AI Performance Testing
Essential source for Derek's audience:
- **Ornith 35B on DGX Spark:** ~36 tok/s at FP8, 3M token context window → [Link](https://x.com/sudoingX/status/2070922455053676788)
- **Self-verification behavior observed** in agentic mode → [Link](https://x.com/sudoingX/status/2070931222084395207)
- **DeepSeek V4 Flash REAP'd to 180B on single DGX Spark:** 22 tok/s with spec-decode → [Link](https://x.com/sudoingX/status/2070156027782484446)

### @Teknium (Hermes Agent Core Dev)
- Referenced the original MoA paper: https://arxiv.org/abs/2406.04692 → [Link](https://x.com/Teknium/status/2070977299168792752)

### Builders to Follow (per @catamarammed, June 27):
- @NousResearch — Mixture of Agents 2.0
- @Teknium — Hermes Agent core dev
- @mr_r0b0t — /learn prompt workflow
- @HermesOneApp — one-command install
- @ddny09 — Chinese Hermes tutorials
- @Kepler1571 — ObserveCo observability
- @HorbunovDima — MoA benchmarker

---

## 5. Benchmark & Performance Data on MoA Systems

### NousResearch Claims:
- **8% higher than Opus 4.8** and **11% higher than GPT 5.5** on HermesBench (upcoming benchmark)
- Based on mixing GLM 5.2 + Opus 4.8 via Nous Portal with GPT 5.5

### Local MoA Performance Context:
- Ornith 35B at FP8 on DGX Spark: ~78 tok/s (Q4), ~36 tok/s (FP8) — usable for agentic workloads
- Qwen3.6-27B AEON Ultimate: 10x faster than stock on complex reasoning tasks
- Concurrent performance: SpaceTimeViking reports 2000 tok/s concurrent on single DGX Spark with Gemma 4 models

### Cost Comparison (for Derek's Tutorial):

| Setup | Monthly Cost | Quality Tier | Local? |
|-------|-------------|--------------|--------|
| NousResearch MoA (premium presets) | $1-5k/mo API costs | Best-in-class | No |
| NousResearch MoA (open models) | ~$100-300/mo via OpenRouter | Good | No |
| Tourbillon + AEON-7 on DGX Spark | ~$100 hardware (one-time, plus electricity) | Near-lossless | **Yes** |

---

## 6. Content Angles for Derek's Tutorial Thread

### Angle 1: "How to Build a Local AI Council of Agents"
- Derek walks through his own Tourbillon setup
- Shows CEO/CTO delegation pattern with AEON-7 models
- Compares local MoA cost vs cloud MoA cost dramatically
- Key hook: "I built the same thing as NousResearch's MoA — but entirely on my desk, for $100"

### Angle 2: "The MoA Architecture Explained (With Live Demo)"
- Explain the advisor-aggregator pattern conceptually
- Show Derek's implementation in Tourbillon
- Demonstrate with real tasks: coding, research, analysis
- Key hook: "Here's exactly how Mixture of Agents works — and how to build it locally"

### Angle 3: "Why Local MoA Beats Cloud MoA (For Privacy, Cost, Freedom)"
- Direct comparison: same task, two setups
- Privacy: no data leaves your machine
- Cost: $100 hardware vs thousands in API calls
- Freedom: uncensored models, no rate limits, no censorship

### Angle 4: "From Tourbillon to MoA — Building Derek's AI Team"
- Story-driven: how Derek went from single agent → multi-agent council
- Shows the evolution of his architecture
- Practical tutorial with screenshots/code snippets
- Key hook: "I built an AI team that works while I sleep"

---

## 7. Recommended Sources & Links for the Thread

### Primary Sources:
1. NousResearch MoA Announcement: https://x.com/NousResearch/status/2070610321278988385
2. MoA Documentation: https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents
3. How-to Guide: https://actionableops.com/hermes-howto/mixture-of-agents
4. Original MoA Paper (arXiv): https://arxiv.org/abs/2406.04692

### Derek's Context:
5. Tourbillon Platform: https://github.com/dcolley/tourbillon
6. Derek on AEON-7 + DGX Spark: https://x.com/DerekColley_/status/2070545368891212014

### Performance Data:
7. Ornith 35B FP8 testing: https://x.com/sudoingX/status/2070931222084395207
8. SpaceTimeViking Ornith release: https://x.com/SpaceTimeViking/status/2070987934841368929
9. DGX Spark model benchmarks: https://x.com/MiaAI_lab/status/2070859135399182444

### Community Perspectives:
10. Weaviate on MoA vs Routing: https://x.com/CShorten30/status/2071254841976897545
11. Open Source AI rallying point: https://x.com/DerekColley_/status/2070540858236256448

---

## 8. Key Quotes Worth Using

**On MoA Architecture:**
> *"Mixture of Agents combines the models you can access into one... The reference models answer in parallel. Your aggregator reads their responses and runs the task, calling tools and repeating the loop as needed."* — NousResearch

**On Local AI Value:**
> *"The strongest models are gated and access is granted only to a select few... They've built a way to beat the frontier without depending so much on the gated models. It's basically one model acting on the thinking of several."* — Community interpretation (zhodonx)

**On Derek's Approach:**
> *"Toubillon is a local-first orchestration platform. By running local agents on DGX Spark, I don't need to cap my agent's token budget..!"* — @DerekColley_

---

## 9. Follow-Up Topics for Future Content

1. **DGX Spark + AEON-7 Performance Benchmarking** (XP-5) — Derek is already working on this
2. **GGUF Conversion Deep Dive** — Derek noted quality differences between converters (~5x perplexity gap)
3. **Local AI Hardware Showdown** — DGX Spark vs alternatives, multi-node setups
4. **Agent Observability & Tracing** — @Kepler1571's ObserveCo work is relevant
5. **MoA for Specific Use Cases** — coding tasks, research automation, creative work

---

## 10. Risks & Considerations

- **NousResearch MoA is cloud-focused:** Derek's tutorial must clearly distinguish local vs cloud approaches
- **Benchmark claims are preliminary:** NousResearch hasn't published full HermesBench data yet
- **DGX Spark supply is limited:** Content should acknowledge hardware constraints honestly
- **AEON-7 models are niche:** Audience may need guidance on accessing these specific model variants
- **Derek's promise timing:** He said "next week" after June 27 — content should be ready by July 4

---

*Research compiled: June 29, 2026*  
*Assign to: Curator for review before drafting*
