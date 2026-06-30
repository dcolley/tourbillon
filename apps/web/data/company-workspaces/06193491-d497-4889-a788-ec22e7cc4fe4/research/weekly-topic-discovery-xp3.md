# Weekly Topic Discovery & Trend Monitoring — Research Summary

**Issue:** XP-3 | **Priority:** High | **Date:** June 29, 2026  
**Goal ID:** 8a472449-7360-4ca6-b95f-e91b8fba0ccf (Grow @derekcolley_ followers — Q3 2026)

---

## Executive Summary

This research identifies current trending topics in Derek's interest areas that haven't been covered yet and surfaces new content opportunities. Key findings include significant developments in MTP speculative decoding for MoE models, growing decentralized AI compute networks (Pluralis Agora), urgent time-sensitive opportunities (Chronara AI airdrop closing June 30), and emerging GGUF quantization comparisons gaining community traction.

---

## 1. Hot Trending Topics — Fresh Opportunities

### 🔥 TOP PRIORITY: MTP Speculative Decoding for MoE Models

**Why This Is Critical:** Derek has been running Qwen3.6 models on DGX Spark. The recent MTP (Multi-Token Prediction) developments directly impact his benchmark results and could dramatically improve his local inference speed.

#### Key Findings:

**RTX 5060 Ti Results — Significant Speedup:**
- Qwen3.6-35B-A3B went from **98 t/s to 144 t/s (1.47x improvement)** with MTP draft-2
- Source: https://njannasch.dev/blog/mtp-speculative-decoding-qwen-3-6-5060ti/

**RTX 3090 Results — Mixed/Negative:**
- Some tests showed **no net speedup** on A3B MoE models with llama.cpp + Q4
- Cache-OFF preference appears A3B-class specific, not general rule
- Source: https://hackmd.io/ODXuOQNzSiyUITz7g9mtBw

**Critical Context for Derek:**
- The 35B-A3B model has **35B total parameters but only 3B active per token**, so baseline decoding is already cheap
- Speculative decoding works by trading idle compute for speed — on MoE models where most params are inactive, there's less "idle" to trade
- vLLM with matched flags showed **+27.5% faster decode rate** with MTP k=1 (N=5 trials × 5 prompts)
- Source: https://github.com/thc1006/qwen3.6-speculative-decoding-rtx3090

**SpaceTimeViking's DFlash Connection:**
- SpaceTimeViking mentioned getting "DFlash working" on Ornith models with **200-300% performance over stock**
- DFlash appears to be a speculative decoding technique similar to MTP but optimized for Blackwell architecture
- This is highly relevant to Derek's DGX Spark work

#### Content Opportunity:
**"MTP Speculative Decoding on MoE Models: Does It Actually Work?"**
- Run Derek's own benchmarks: Qwen3.6-35B-A3B with MTP on DGX Spark
- Compare results against RTX 3090 and RTX 5060 Ti data from community
- Address the "cache-OFF preference" A3B-specific issue
- Position Derek as authority on speculative decoding for MoE models

---

### 🔥 URGENT: Chronara AI Public Airdrop Closing June 30

**Why This Is Urgent:** Only **1 day remaining** (June 29 → June 30 deadline). Chronara is a decentralized compute network relevant to Derek's interests in decentralized AI infrastructure.

#### Key Findings:
- Chronara AI entering commercial phase
- Public Airdrop closing on **June 30, 2026** (TODOMORROW)
- Community rewards and raid phases ending
- Source: https://chronara.io/news

#### Content Opportunity:
**"Decentralized Compute Networks Roundup — Including One Closing in 24 Hours"**
- Mention Chronara airdrop deadline as urgent call-to-action
- Compare with Pluralis Agora, Akash Network, sparkl-network
- Position Derek as informed about decentralized compute ecosystem

---

### 🟡 HIGH: Pluralis Agora Gaining Traction

**Why This Matters:** Derek follows @jun_song who advocates for decentralized AI. Pluralis Agora is the most actively discussed decentralized training network right now.

#### Key Findings:
- @jbrukh tweeted June 13, 2026: *"Decentralized AI training networks like @Pluralis' Agora are the only true counterbalance to centralized AI"*
- Pluralis Research working on "Protocol Learning" — decentralized, communication-efficient model-parallel training
- Documentation available at https://pluralis.ai/docs/
- Canonocal Labs published comprehensive map of all decentralized AI alternatives (May 27, 2026)

#### Content Opportunity:
**"Why Decentralized AI Training Networks Are the Only Counterbalance to Big Tech"**
- Follow Derek's "open source must win" philosophy
- Reference @jun_song's work on decentralized compute networks
- Position Pluralis Agora as practical implementation of these concepts

---

### 🟡 MEDIUM: GGUF Quantization Comparisons Gaining Traction

**Why This Matters:** Directly relevant to Derek's GGUF converter benchmarking work. Community is actively discussing quantization choices.

#### Key Findings:
- Q4_K_M vs Q8_0 vs GGUF format comparison trending (June 19, 2026)
- Slide deck covers RAM savings by model size (3B-70B), quality loss by quantization level
- Source: https://www.promptquorum.com/local-llms/llm-quantization-explained

#### Content Opportunity:
**"GGUF Quantization Showdown: What We Learned from Derek's Benchmarking"**
- Tie into XP-5 research (Heretic vs knoopx findings)
- Update community with latest quantization best practices
- Reference specific model sizes and RAM savings

---

### 🟡 MEDIUM: Local Coding Models — Top 7 in 2026

**Why This Matters:** Derek is deeply interested in agentic coding models (Ornith 35B, scaffold-RL training). Community wants to know which models work best locally for coding tasks.

#### Key Findings:
- KDnuggets published "Top 7 Coding Models You Can Run Locally in 2026" (5 days ago)
- Topics covered: private AI coding, fast GGUF inference, agentic workflows, multimodal development
- Source: https://www.kdnuggets.com/top-7-coding-models-you-can-run-locally-in-2026

#### Content Opportunity:
**"Which Local Coding Model Actually Works? Derek's Testing Results"**
- Compare community picks with Derek's Ornith testing data
- Address scaffold-RL vs standard RL training approaches
- DGX Spark performance benchmarks for coding tasks

---

## 2. What @derekcolley_'s Key Contacts Have Been Tweeting About (June 20-29)

### @sudoingX (Sudo su) — Recent Activity:
From Derek's tweet feed analysis:
- Running Ornith 35B MoE at FP8 on DGX Spark (~36 tok/s, 3M token context window)
- Observed self-verification behavior in agentic mode — model double-checked its own work mid-task
- DeepSeek V4 Flash REAP'd to 180B running on single DGX Spark with spec-decode (22 tok/s)

### @SpaceTimeViking (ÆON FORGE / AEON-7):
From SpaceTimeViking's tweet feed analysis:
- **Ornith 1.0 AEON Ultimate Uncensored** release (June 27) — BF16 + NVFP4 for DGX Spark/Blackwell, DFlash working with 200-300% performance over stock
- **Qwen3.6-27B AEON Ultimate** completed complex puzzle in 15 seconds vs 130 seconds on stock (8.7x improvement)
- Abliteration research — model scored higher than 310B parameter model after removing censorship overhead
- Building community benchmarking leaderboard for DGX Spark performance

### @jun_song — Recent Activity:
From Derek's tweet feed analysis:
- Shared "open source must win" post emphasizing decentralized inference/ML, open source datasets, RL/SFT/post-training, world model research, physical AI & robotics, agent loops & harnesses as critical infrastructure
- Critical of top researchers (e.g., Karpathy) joining closed companies like Anthropic

---

## 3. New Models, Tools, and Research Papers Relevant to Derek's Content Pillars

### New/Updated Models:
1. **Ornith 1.0 AEON Ultimate Uncensored** — June 27 release by SpaceTimeViking
   - BF16 + NVFP4 for DGX Spark/Blackwell architecture
   - DFlash working with 200-300% performance over stock
   - GitHub: https://github.com/AEON-7/Ornith-1.0-35B-AEON-Ultimate-Uncensored

2. **Qwen3.6-35B-A3B MTP GGUF** — Official ggml-org release with speculative decoding support
   - Hugging Face: https://huggingface.co/ggml-org/Qwen3.6-35B-A3B-MTP-GGUF

3. **knoopx's Qwen3.6-35B-A3B-NVFP4 GGUF** — Production-ready converter
   - Hugging Face: https://huggingface.co/knoopx/Qwen3.6-35B-A3B-NVFP4-GGUF

### New/Updated Tools:
1. **Advanced-gguf-quantizer** — GitHub discussion #23853
   - Designed for highest quality llama.cpp models with NVFP4/MXFP6 support
   - Uses quantization tricks beyond standard K-Quants

2. **TurboQuant + QJL + PolarQuant + DFlash** unified tools (GitHub elizaOS/llama.cpp)
   - Recently updated (4 days ago as of research date)
   - Perplexity measurement and quality metrics tooling

### Research Papers:
1. **"Which Quantization Should I Use?"** — ArXiv Jan 2026
   - Unified empirical comparison of llama.cpp GGUF quantization formats
   - Source: https://arxiv.org/html/2601.14277v1

---

## 4. Cross-Reference with curation.md — Stale vs Fresh Themes

### 🟢 FRESH OPPORTUNITIES (Not Yet Covered):

1. **MTP Speculative Decoding on MoE Models**
   - Status: Not covered by Derek yet
   - Potential: HIGH — directly impacts his benchmark results and content strategy
   - Angle: "Testing MTP on DGX Spark — Do Results Match RTX 3090/5060 Ti data?"

2. **Pluralis Agora / Decentralized Training Networks**
   - Status: Not covered by Derek yet
   - Potential: HIGH — aligns with his "open source must win" philosophy and @jun_song's advocacy
   - Angle: "Why Decentralized AI Training Is the Only Counterbalance to Big Tech"

3. **Chronara AI Airdrop (Urgent)**
   - Status: Not covered by Derek yet
   - Potential: MEDIUM-HIGH — time-sensitive, relevant to decentralized compute interests
   - Angle: "Decentralized Compute Networks Roundup + One Closing in 24 Hours"

### 🟡 POTENTIALLY STALE (Already Covered):

1. **Basic GGUF converter comparisons** — Derek's Heretic vs knoopx benchmark is fresh data, but general converter comparisons are covered
   - Update: XP-5 research will address this with specific quality gap data

2. **DGX Spark performance benchmarks** — Already active area for Derek
   - Keep monitoring for MTP-specific results that could update his existing content

### 🔴 STALE / LOW PRIORITY (Avoid):

1. **Basic Qwen3.6 model announcements** — These are old news; focus on SPECULATIVE DECODING improvements instead
2. **General "local AI is getting easier" guides** — Too broad, low signal-to-noise for Derek's audience

---

## 5. Priority Areas Recap (From Issue XP-3)

### ✅ MoA / Council of Agents:
- Status: Research complete (XP-4), awaiting Curator review and Author drafting
- Timeline: Derek promised tutorial June 27, still pending — **URGENT**

### ✅ MTP Speculative Decoding (@ggerganov endorsed as "significant milestone"):
- Status: Fresh trending topic identified in this research cycle
- Recommendation: Create separate issue for Curator to review and add to pipeline

### ⚠️ Tourbillon GitHub Launch — Community Reaction:
- Limited community data found; Tourbillon uses @mastra workflow with human-in-the-loop pattern
- All code open source on github.com/dcolley/tourbillon
- Recommendation: Monitor for more community reaction data before creating content issue

### ✅ New GGUF Converter News / Benchmark Comparisons:
- Status: Research complete (XP-5), awaiting Curator review and Author drafting
- Key finding: Heretic vs knoopx ~5× pp gap, ~3× tg gap on NVFP4 Qwen3.6-35B

---

## 6. Recommended Issues to Create for Curator

Based on this research, I recommend creating the following issues for Curator to review and add to the pipeline:

### Issue 1: MTP Speculative Decoding Benchmarking (Priority: High)
**Title:** "Benchmark MTP Speculative Decoding on DGX Spark — Qwen3.6-35B-A3B Results"  
**Description:** Derek should run his own benchmarks of MTP speculative decoding on his DGX Spark setup with Qwen3.6-35B-A3B models. Community data shows mixed results (RTX 5060 Ti: +47% speedup, RTX 3090: no improvement). Derek's DGX Spark data would be valuable and position him as authority on speculative decoding for MoE models. Include SpaceTimeViking's DFlash findings as comparison point.

### Issue 2: Decentralized AI Compute Networks Roundup (Priority: High)
**Title:** "Decentralized AI Compute Networks — Pluralis Agora, Chronara AI, Akash Network"  
**Description:** Derek should cover the decentralized compute network ecosystem including Pluralis Agora's Protocol Learning, Chronara AI's closing airdrop (URGENT - June 30 deadline), and Akash Network. Tie into his "open source must win" philosophy and @jun_song's advocacy for decentralized AI infrastructure.

### Issue 3: Tourbillon Community Feedback Request (Priority: Medium)
**Title:** "Tourbillon User Feedback — What the Community Wants to See Next"  
**Description:** Derek should post a community engagement thread asking Tourbillon users what features they want next, benchmarking priorities, and use cases. This builds community while gathering research for future content. Include link to github.com/dcolley/tourbillon.

---

## 7. Sources & Links

### MTP Speculative Decoding:
1. RTX 5060 Ti results (144 t/s): https://njannasch.dev/blog/mtp-speculative-decoding-qwen-3-6-5060ti/
2. RTX 3090 mixed results analysis: https://hackmd.io/ODXuOQNzSiyUITz7g9mtBw
3. GitHub benchmark repo (thc1006/qwen3.6-speculative-decoding-rtx3090): https://github.com/thc1006/qwen3.6-speculative-decoding-rtx3090
4. vLLM MTP results (+27.5% faster decode): GitHub sibling repo (thc1006/qwen3.6-vllm-2x3090)

### Decentralized Compute:
5. Pluralis Agora documentation: https://pluralis.ai/docs/
6. @jbrukh tweet on Pluralis Agora (June 13): https://x.com/jbrukh/status/2065941418439258114
7. Chronara AI news (airdrop closing June 30): https://chronara.io/news
8. Canonical Labs decentralized AI map (May 27): https://www.canonical.cc/labs/decentralized-ai/

### GGUF Quantization:
9. Q4_K_M vs Q8_0 comparison slide deck (June 19): https://www.promptquorum.com/local-llms/llm-quantization-explained
10. GGUF format guide (DataCamp, June 17): https://www.datacamp.com/tutorial/gguf-format-a-complete-guide

### Community Resources:
11. Best Local LLMs Megathread r/LocalLLaMA (Apr 2026): https://www.reddit.com/r/LocalLLaMA/comments/1sknx6n/best_local_llms_apr_2026/
12. Top 7 Coding Models for Local Inference (KDnuggets, 5 days ago): https://www.kdnuggets.com/top-7-coding-models-you-can-run-locally-in-2026

### Model Releases:
13. Ornith 1.0 AEON Ultimate Uncensored GitHub: https://github.com/AEON-7/Ornith-1.0-35B-AEON-Ultimate-Uncensored
14. knoopx Qwen3.6 NVFP4 GGUF Hugging Face: https://huggingface.co/knoopx/Qwen3.6-35B-A3B-NVFP4-GGUF

---

## 8. Action Items for Curator

### Immediate (This Week):
1. **Review MTP Speculative Decoding issue** — Create Author task for Derek to run benchmarks on DGX Spark
2. **Review Decentralized Compute Networks issue** — Create Author task, especially urgent Chronara AI coverage (deadline June 30)
3. **Check XP-4 and XP-5 status** — These are already with Curator; confirm if Author issues have been created

### Next Week:
1. **Monitor Tourbillon community reaction** — Continue tracking GitHub discussions, Reddit threads, Twitter mentions
2. **Track new model releases** — Weekly scan for new GGUF converters, quantization tools, and benchmark data
3. **Follow up on @sudoingX and @SpaceTimeViking updates** — Their benchmarks directly inform Derek's content opportunities

---

*Research compiled: June 29, 2026*  
*Assign to: Curator for review and pipeline addition*
