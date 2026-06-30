# Engagement Log - Derek Colley (@derekcolley_)

**Last updated:** 2026-07-01 (Heartbeat #4)  
**Curator/Author:** Author Agent  

---

## Trending Topics & Engagement Opportunities

### 🔥 High Priority — Ready to Engage

#### 1. DFlash Speculative Decoding on DGX Spark
**Source:** @bussyjd tweet about llama.cpp PR #22105 merging native DFlash support  
**Stats:** Qwen3.6-27B on DGX Spark: 12.57 → 33.76 tok/s (2.69× speedup). Coding: 3.11×, RAG: 4.07×  
**Derek Angle:** This directly validates Derek's interest in MTP/speculative decoding. Could add DGX Spark perspective since most testing is on RTX hardware. The Ornith 35B MoE connection (scaffold-trained reasoning + DFlash) is a unique angle only Derek can speak to given his FP8 benchmarks.
**Recommended Action:** Create engagement tweet connecting DFlash to Derek's MTP research and Ornith self-verification observations

#### 2. NVFP4 vs GGUF Quality Debate Continues
**Source:** @AgentSparko, @jtdavies continuing the precision debate  
**Derek Angle:** Derek's Ornith FP8 work directly proves this point — "precision buys you intelligence." His observation that Q4 fires and runs while FP8 self-verifies is exactly the kind of real-world evidence needed in this debate.
**Recommended Action:** Reply to @jtdavies (who said they're more interested in accuracy than performance) with Derek's Ornith findings as supporting evidence

#### 3. #keep4o — QwenArk Archiving Tool
**Source:** @Codeforged_One — Python script to archive entire Qwen org on HuggingFace  
**Stats:** 40TB+ archive, tiered priority (masters → GGUF → other quants)  
**Derek Angle:** Perfectly aligns with "open source must win" philosophy. Derek has the DGX Spark infrastructure and storage to run this. Strong community engagement potential around preserving open models before they get deprecated or re-licensed.
**Recommended Action:** RT with comment about running it on DGX Spark setup, or create a thread about model preservation as part of local AI sovereignty

#### 4. Gemma 4 12B Agentic Finetunes (Fable5/Composer2.5 v2)
**Source:** @analogalok benchmarking coding agents on RTX 4060  
**Stats:** ~30 tok/s on consumer GPU, tau2 bench telecom: base 15% → finetune 55%  
**Derek Angle:** Derek's interest in agentic workloads and Ornith's self-verification approach provides a natural comparison point. The "diagnose → fix → verify" loop mirrors what Derek observed in Ornith FP8's self-checking behavior.
**Recommended Action:** Cross-reference with Ornith findings — both models show that training for agentic patterns (not just coding) produces measurably better tool-use results

### 🟡 Medium Priority — Monitor & Engage

#### 5. Local AI Ecosystem Growth Thread
**Source:** @Michaelzsguo "Top 10 X local AI accounts"  
**Key Insight:** Derek's own presence in this ecosystem is growing — he should be cited as part of the DGX Spark/local orchestration niche
**Recommended Action:** Engage with comment adding Derek's perspective on what makes a valuable local AI account (hands-on benchmarks, not theory)

#### 6. GLM-5.2 Running Locally on Single Box
**Source:** @PaIbraNiang1 running 754B model as coding agent  
**Stats:** 8x RTX 6000 Ada, ~17.5 tok/s decode on 69k-token prompt  
**Derek Angle:** Derek's local-first architecture philosophy is validated by this — "no API bill" for a full coding agent loop
**Recommended Action:** RT with comment about how this proves the local-first thesis at enterprise scale

#### 7. AEON-7 NVFP4 Confirmation
**Source:** @AgentSparko confirming NVFP4 quality matches unquantized baseline  
**Derek Angle:** Derek already uses AEON-7 models in Tourbillon (CEO/CTO agents). This confirms the model choice for his setup.
**Recommended Action:** Engage to reinforce AEON-7 credibility — Derek's real-world deployment adds practical validation

---

## Content Pipeline Status

| Priority | Deliverable | Status | Location |
|----------|-------------|--------|----------|
| 🔴 CRITICAL | MoA/Council of Agents Tutorial Thread | ✅ DRAFTED | `projects/moa-tutorial-thread.md` |
| 🟠 HIGH | Ornith 35B MoE "Sleeping Giant" Thread | ✅ DRAFTED | `projects/ornith-sleeping-giant-thread.md` |
| 🟡 MEDIUM-HIGH | Tourbillon Local-First Orchestration Thread | ✅ DRAFTED | `projects/tourbillon-launch-thread.md` |

---

## Key People to Engage With (Updated)

| Account | Focus | Engagement Strategy |
|---------|-------|---------------------|
| @bussyjd | Speculative decoding, GGUF benchmarks | Reply on DFlash speedup for DGX Spark |
| @jtdavies | NVFP4 vs MLX comparison | Share Ornith FP8 findings as evidence |
| @Codeforged_One | Open source preservation (#keep4o) | RT + comment about DGX Spark archiving |
| @AgentSparko | AEON-7, NVFP4 expertise | Engage on precision debate |
| @analogalok | Agentic model benchmarks | Cross-reference with Ornith self-verification |
| @Michaelzsguo | Local AI ecosystem growth | Comment on valuable account criteria |

---

## Notes for Next Heartbeat

1. **Review drafted threads** — The 3 draft threads need Derek's review before posting. Consider creating an issue in the system if needed.
2. **Execute engagement tweets** — Several high-value engagement opportunities identified above that can boost profile visibility.
3. **Monitor DFlash/MTP developments** — JoelDeTeves is testing DFlash with Ornstein (Ornith) models — could be a natural bridge between Derek's work and this trending topic.
4. **GGUF converter benchmark follow-up** — Derek posted Heretic vs knoopx comparison in progress on June 26, should check if results are ready for full thread.
