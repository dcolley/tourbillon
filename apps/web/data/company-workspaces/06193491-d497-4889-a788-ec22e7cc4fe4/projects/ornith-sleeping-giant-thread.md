# Ornith 35B MoE — "Sleeping Giant" Thread (Draft)

**Status:** DRAFT  
**Priority:** HIGH  
**Angle:** Derek ran FP8 at near-lossless quality, observed self-verifying tool use that Q4 quantization misses. People are sleeping on this model because it's not getting the hype of bigger names.

---

## THREAD: A 35B Agentic Coding Model That Does Self-Verification at Near-Full Precision

### Tweet 1/8 (Hook)
Everyone's obsessed with parameter counts. I think we're missing something more important.

I ran Ornith 35B MoE at FP8 precision on vLLM — and watched it do something most larger models DON'T: self-verify tool calls before executing them.

It plans, checks its work, corrects errors. The Q4 version just fires off whatever comes back.

Here's what I learned 👇

### Tweet 2/8
**The setup:**

Hardware: DGX Spark (local inference)
Model: unsloth/qwen3.6-35b-a3b-mtp (Ornith variant)
Format comparison: Q4_K_M via llama.cpp vs FP8 via vLLM

Results:
• Q4_K_M → ~78 tok/s on llama.cpp (fast prefill, good throughput)
• FP8 → ~36 tok/s unoptimized baseline in vLLM (slower but MASSIVELY better quality)

The speed tradeoff is real. But the intelligence gap? Even more real.

### Tweet 3/8
**What I mean by "precision buys you intelligence":**

When running at Q4, Ornith generates tool calls and fires them off. Whatever comes back — it accepts as truth. No verification step. It's essentially hallucinating confidence in the results.

At FP8, something changes. The model:
1. Plans the tool call structure first
2. Reviews what it generated
3. Double-checks parameters against available schemas
4. Only THEN executes

This isn't a tiny difference. This is the difference between "AI that looks like it understands" and "AI that actually thinks through its actions."

### Tweet 4/8
**Why this matters for AGENTS (not just chat):**

Most people test models on benchmark scores — GSM8K, MMLU, etc. These measure static knowledge or reasoning on known problems.

But agents operate in the real world. They make tool calls with external APIs and systems. If your model can't verify its own tool call outputs before trusting them, every external interaction is a potential failure point.

Ornith's FP8 version treats tool use like a deliberative process — not just pattern matching.

### Tweet 5/8
**Scaffold-RL: Why Ornith is architecturally different**

Most coding RL models only optimize for the final code output. "Did it solve the problem?" ✓ or ✗

Ornith uses scaffold-RL training where the model learns the TASK STRUCTURE alongside code generation. It's learning to plan, to break down problems, to structure its reasoning — not just produce correct code at the end.

This is why you see self-verification behavior emerge. The scaffolding IS the planning capability baked into the weights.

### Tweet 6/8
**Practical implications for local AI users:**

If you're running agentic workloads (coding assistants, tool-use agents, automation):

→ Q4 quantization is fine for throughput but will miss verification steps
→ FP8 or higher precision unlocks behavioral capabilities that lower-precision versions simply don't have
→ The ~36 tok/s in vLLM might seem slow, but for agent workloads where quality matters more than raw speed, it's actually the sweet spot

Your model isn't just "slower when quantized." Sometimes it becomes a DIFFERENT MODEL.

### Tweet 7/8
**Where I'm taking this:**

I want to run Ornith FP8 through my MoA (Mixture-of-Agents) pattern next — running multiple agents with self-verification capabilities, then synthesizing their outputs. The combination of scaffold-trained reasoning + multi-agent deliberation could be genuinely powerful for complex agentic tasks.

Local hardware makes this affordable in a way cloud APIs never would. No per-token costs means I can experiment aggressively.

### Tweet 8/9 (Resources)
**Want to try it yourself?**

Model: Look for Ornith variants on HuggingFace
Quantization: Try both Q4_K_M and FP8, compare tool-use behavior side by side
Engine: llama.cpp for speed, vLLM for precision

The key insight isn't about this specific model — it's about recognizing that quantization level changes MORE than just throughput. It changes what the model can actually DO when operating as an agent.

Sleeping giant status: I think most people are underestimating what a well-quantized 35B MoE with proper precision can do for local agentic workloads.

---

**Tags:** @NousResearch (Ornith creators), @ggerganov (GGUF ecosystem), @UnslothAI