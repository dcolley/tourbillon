# Derek Colley — Topics of Interest

## Primary Focus Areas

### 1. Local AI & Model Inference (Core Expertise)
- **Running models on consumer/desktop hardware** — NVIDIA DGX Spark is his primary platform; runs multiple units. Deep expertise in GGUF quantization, llama.cpp, vLLM, and model serving on single-box setups.
- **Quantisation formats** — NVFP4, Q3_K_M, FP8, Q4, GGUF conversions. He benchmarks conversion quality (e.g., Heretic vs knoopx/RedHatAI converters).
- **Model comparisons & benchmarking** — Regularly publishes detailed bench articles comparing models: Qwen 3.6-35B-A3B-MTP, Step 3.7 Flash, Nemotron-3-Super, Ornith 35B MoE, DeepSeek V4 Flash (REAP'd to 180B).
- **Inference engines** — llama.cpp, vLLM, ds4 engine, LM Studio, Unsloth tools. He tests and reports on performance differences between engines.

### 2. AI Agents & Agent Orchestration
- **Agent loops & harnesses** — Deep knowledge of Mastra's agent architecture (agent loop, harness class, observational memory, modes). Writes long-form threads explaining agent patterns.
- **Multi-agent systems** — Building "Tourbillon" with CEO/CTO agents delegating work via AEON-7 models on DGX servers. Interested in MoA (Council of Agents), sub-agent delegation, human-in-the-loop approvals.
- **Agentic coding models** — Strong interest in Ornith 35B MoE's scaffold-RL training approach where the model learns planning/structure alongside code generation. Obsesses over self-verifying tool use at higher precision.

### 3. Decentralised AI Infrastructure
- **Decentralised inference networks** — Believes this is an "Uber-like moment" for AI compute sharing. Active in sparkl-network, Pluralis Agora (decentralised pretraining).
- **Distributed training & compute** — Pipeline parallelism across consumer GPUs over public internet, federated learning concepts. Interested in anyone with spare compute contributing to networks.

### 4. Open Source AI Advocacy
- **"Open source must win"** — Strong belief that open-weight models are fragile and need a rallying point. Critical of top researchers (e.g., Karpathy) joining closed companies like Anthropic.
- **GGUF/local AI ecosystem** — Deeply embedded in the llama.cpp / GGUF community. Follows Georgi Gerganov (@ggerganov), Mishig, Unsloth closely. Advocates for local AI as privacy-preserving and uncensored.

### 5. Privacy & Digital Freedom
- **GrapheneOS / privacy-focused infrastructure** — Installed GrapheneOS on Pixel 10. Concerned about UK digital ID laws, "scan at source" software, Google's training practices.
- **WireGuard, self-hosting, anti-surveillance** — Technical advocacy for user-controlled infrastructure over corporate platforms.

### Secondary Interests

### 6. Databases & Data Infrastructure
- **SurrealDB, PostgreSQL graph queries** — Interested in databases with embedded embeddings and graph capabilities for AI applications.
- **Cognee / long-context memory** — Wants to integrate cross-company memory (projects, goals, tasks) into Tourbillon.

### 7. Hardware Enthusiasm
- **NVIDIA DGX Spark collector** — Has multiple units, discusses power draw (amps), cooling, earlyOOM protection. Asks for DGX Station GB300 "for a friend."
- **Model crunching as hobby/passion** — Runs benchmarks for hours on end, publishes detailed results with hardware specs and tok/s numbers.

### 8. Business Strategy & AI Economics
- **Blue Ocean Strategy thinking** — Believes apps that can't compete with free need to pivot.
- **AI spend management** — Advocates using AI for cron/script generation (save tokens for creative work), tool calling for context ingestion.

### 9. Physical Engineering / Steampunk
- Steam-powered bikes, mechanical engineering appreciation. Occasional interest in ROS2, Raspberry Pi robotics (oomwoo open-source robot vacuum).

## Topics to Avoid or Approach Carefully
- **Major closed-model hype** — He dismisses new model announcements as "meh" if they don't offer local/open alternatives. Dislikes being distracted by shiny new things that lack GGUF/local support.
- **Cloud-only AI solutions** — Skeptical of cloud-dependent approaches; prefers on-prem, self-hosted, local inference.
- **Corporate data harvesting** — Strongly opposed to companies using user content for model training without opt-in consent.

## Key People & Accounts He Follows/Engages With
- @sudoingX (Sudo su) — Ornith/DGX Spark benchmarking partner
- @jun_song — Decentralised AI advocacy, compute networks
- @SpaceTimeViking (@AEON7_) — AEON-7 models for Tourbillon agents
- @ggerganov / @mishig25 — llama.cpp & GGUF ecosystem
- @UnslothAI — Model quantisation tools
- @mastra — Agent harness framework
- @Alibaba_Qwen — Qwen model releases
- @0xSero — REAP pruning technique
- @PluralisResearch — Decentralised training

## Future Content Opportunities
1. **Tourbillon features & updates** - features recently added to the github repo: https://github.com/dcolley/tourbillon
2. **MoA / Council of Agents tutorial** — He promised to share this (tweeted June 27).
3. **DGX Spark multi-unit benchmarking series** — Comparison of different models across multiple Sparks with spec decode, MTP, etc.
4. **Tourbillon agent system deep-dives** — How CEO/CTO agents delegate, AEON-7 integration, cross-company memory.
5. **Decentralised AI network participation guides** — How to join sparkl-network or Pluralis Agora from a desk setup.
6. **GGUF conversion quality comparison series** — Following up on his Heretic vs knoopx converter findings.
7. **Agent self-knowledge / capability benchmarking** — Models that know their own limits (ties into his "know your capabilities" thread).
8. **Mastra AI Releases** - Showcase existing or new features, especially how this is used in Tourbillon
