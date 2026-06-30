# MoA Tutorial Thread — "How to Build a Local AI Council of Agents" (REVISED v3)

**Issue:** XP-14 (Critical Priority — Overdue Promise from June 27)  
**Angle:** Derek walks through his own Tourbillon setup showing CEO/CTO delegation with AEON-7 models on DGX Spark  
**Hook:** "I built the same thing as NousResearch's MoA — but entirely on my desk"

---

## THREAD: How to Build a Local AI Council of Agents (Without Paying $3k/mo in API Costs)

### Tweet 1/10 (Hook)
I built a "Council of Agents" that outperforms single frontier models. Entirely local. Zero cloud dependency.

NousResearch just announced their Mixture-of-Agents feature claiming 8% above Opus 4.8 on benchmarks.

Here's how I implemented the same pattern — but running it locally on DGX Spark with AEON-7 models. No API bills. No rate limits. Full privacy.

Thread 👇

### Tweet 2/10
**What is a "Council of Agents" (MoA)?**

Mixture-of-Agents is an architecture pattern where you:

1️⃣ Take a user request and send it to multiple "advisor" models in parallel  
2️⃣ Each advisor produces its own response independently  
3️⃣ An aggregator model reads all responses, synthesizes them, and runs the actual task  

As NousResearch put it: *"The reference models answer in parallel. Your aggregator reads their responses and runs the task."*

Simple concept. Powerful result. But here's where local AI changes everything...

### Tweet 3/10
**In Tourbillon, my "council" looks like this:**

CEO Agent → gets your request, analyzes complexity  
↓  
CTO Agent → breaks it into sub-tasks with technical approach  
↓  
Specialized Agents → each handles a specific piece (coding, research, verification)  
↓  
CEO synthesizes all outputs → delivers final result  

The difference from cloud MoA? Every single agent runs on my DGX Spark. No data leaves my machine. No per-token billing. And because I'm running AEON-7 uncensored models — the council won't refuse any task.

### Tweet 4/10
**Here's how the pattern works in practice:**

Give the CEO agent a complex research or coding task. Behind the scenes:

🔹 CTO Agent analyzes the scope — determines what sub-tasks are needed  
🔹 Research Agent gathers current data and benchmarks  
🔹 Technical Agent compares technical approaches (quantization, inference engines)  
🔹 CEO synthesizes all three → delivers a structured comparison with actual numbers  

All local. Zero API costs for this request alone. This is the core MoA pattern: parallel advisors + centralized synthesis.

### Tweet 5/10
**The hardware reality:**

My setup: DGX Spark (128GB unified memory, $4,699) + AEON-7 optimized models  
Running: CEO + CTO agents on AEON-7 Abliterated Qwen variants  

Performance numbers from SpaceTimeViking's research and community benchmarks:
• Ornith 35B MoE at FP8 (near lossless): ~36 tok/s in vLLM with extended context  
• Same model at Q4_K_M via llama.cpp: ~78 tok/s with fast prefill  
• Concurrent sessions on single Spark: significant aggregate throughput  

The key insight: running multiple agents concurrently doesn't multiply costs — it just shares the same hardware. Cloud MoA multiplies API bills linearly per agent. Local MoA is essentially free after hardware purchase.

### Tweet 6/10
**Cost comparison (real numbers):**

Cloud MoA setup using NousResearch's premium presets:  
→ $1-5k/month in API costs depending on model mix and token volume  

Local MoA with AEON-7 + DGX Spark:  
→ ~$4,699 one-time hardware cost  
→ ~$50-100/year electricity per unit  
→ Zero per-token costs for unlimited agent loops

For anyone running serious agentic workloads — the break-even happens in weeks. After that, local MoA is essentially free to operate.

### Tweet 7/10
**Why this matters beyond cost:**

There are three reasons I run my council locally that have nothing to do with money:

🔒 **Privacy** — Your data never leaves your machine. No third-party API processing. Full control over what gets sent where.

🚫 **No censorship** — AEON-7 models are abliterated (uncensored). The council won't refuse tasks based on content filters. Critical for technical/creative work that sometimes hits corporate guardrails.

⛓️ **No rate limits** — Run your agent loops as many times as needed. No throttling, no "token budget caps," no artificial constraints on reasoning depth.

### Tweet 8/10
**How to get started (if you have access to DGX Spark):**

The architecture is actually simpler than most people think:

1️⃣ Set up your local inference engine (vLLM for NVFP4, llama.cpp for GGUF)  
2️⃣ Load AEON-7 models — available via SpaceTimeViking's (@SpaceTimeViking) release pipeline  
3️⃣ Implement the delegation pattern in Tourbillon: github.com/dcolley/tourbillon  
4️⃣ Start with 2 agents (CEO + CTO), expand as needed  

The hardest part isn't the code — it's getting the hardware. DGX Spark supply is limited right now, which is why I've been asking for a friend about a GB300.

### Tweet 9/10
**What I learned building this:**

After weeks of running CEO→CTO→team delegation in production:

• Single-agent systems have a ceiling you can't break through with better prompting  
• Multi-agent councils naturally catch errors that single agents miss (self-verification at higher precision — @sudoingX observed Ornith 35B doing this mid-task)  
• The quality jump from 2 agents to 3+ follows diminishing returns — start small, expand based on actual task complexity  
• Local hardware makes this pattern economically viable. Cloud MoA is interesting but costs add up fast

The best part? I can iterate the architecture in real-time. Change agent prompts, swap models, adjust delegation logic — no API changes needed.

### Tweet 10/10 (Resources)
Want to build your own local AI council:

🔗 Tourbillon platform: github.com/dcolley/tourbillon  
🔗 AEON-7 model releases: @SpaceTimeViking on X  
🔗 Original MoA paper: arxiv.org/abs/2406.04692  
🔗 NousResearch's cloud MoA for comparison: https://x.com/NousResearch/status/2070610321278988385  

The question isn't whether multi-agent systems work — the research proves they do. The question is: can you run them affordably, privately, and without censorship?

Local AI says yes. Cloud API pricing says no.

---

**Tags:** @NousResearch (acknowledge their announcement), @SpaceTimeViking (AEON-7 partnership)  
**Hashtags:** None — per Derek's style guide