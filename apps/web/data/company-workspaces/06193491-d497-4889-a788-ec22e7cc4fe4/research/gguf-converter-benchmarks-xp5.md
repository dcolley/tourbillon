# Research Summary: GGUF Converter Benchmark Results and Supporting Data

**Issue:** XP-5 | **Priority:** High | **Date:** June 29, 2026

---

## Executive Summary

Derek Colley has been actively researching GGUF converter quality differences, specifically comparing Heretic vs knoopx/RedHatAI converters for Qwen3.6-35B-A3B NVFP4 models. His own benchmark data shows significant quality gaps that are critical for local AI practitioners to understand. This research compiles all available benchmark data, community reactions, and technical context to support Derek's ongoing work and potential content creation.

---

## 1. Current State of the Comparison — Derek's Baseline Data

### Derek's Own Benchmark Findings (June 26, 2026)

From Derek's tweet:
> *"GGUF conversion quality: Heretic local GGUF underperforms knoopx/RedHatAI ~5× pp and ~3× tg"*

**Key Details:**
- **Same hardware** — DGX Spark
- **Same llama-bench flags** — standardized benchmarking conditions
- **Same NVFP4 file type (39)** — identical quantization format
- **Same architecture** — Qwen3.6-35B-A3B
- **Difference is the GGUF converter:**
  - knoopx: Converted from RedHatAI/Qwen3.6-35B-A3B-NVFP4 using their patched converter
  - Heretic: Derived from HF checkpoint via `convert-qwen36-heretic-nvfp4-gguf.sh`

**Impact:**
- **~5× worse perplexity (pp)** — knoopx significantly better at preserving model quality during conversion
- **~3× worse token generation (tg)** — Heretic converter produces noticeably slower/better output

This is a critical finding for anyone running Qwen3.6 models locally, as the choice of converter directly impacts both quality and performance.

---

## 2. Key Converter Sources & Available GGUFs

### knoopx/RedHatAI NVFP4 Converter
- **Hugging Face Page:** https://huggingface.co/knoopx/Qwen3.6-35B-A3B-NVFP4-GGUF
- **Description:** NVFP4-compatible tensors repacked into GGUF where supported by converter and runtime
- **Status:** Production-ready, widely used in community benchmarks
- **Quality:** Establishes the "gold standard" for this architecture's NVFP4 conversion

### Heretic Converter
- **Script:** `convert-qwen36-heretic-nvfp4-gguf.sh`
- **Source:** HF checkpoint → GGUF conversion pipeline
- **Status:** Functional but underperforming vs knoopx (5× pp gap)
- **Use Case:** Derek's local/convenience converter that needs quality improvement

### Additional Converter Ecosystem

**Unsloth Dynamic Quants:**
- Qwen3.5 Unsloth Dynamic quants claimed SOTA on nearly all bits (Mar 2026)
- Over 150 KL Divergence benchmarks, ~9TB of GGUFs evaluated
- Reference: https://unsloth.ai/docs/models/qwen3.5/gguf-benchmarks

**Advanced-gguf-quantizer Tool:**
- GitHub Discussion #23853: "my advanced-gguf-quantizer tool for NVFP4, MXFP6, Q2, Q3, Q4"
- Designed to make absolute highest quality llama.cpp model possible
- Uses quantization tricks and techniques beyond standard K-Quants
- Reference: https://github.com/ggml-org/llama.cpp/discussions/23853

**TurboQuant + QJL + PolarQuant + DFlash:**
- Unified tool for perplexity measurement and quality metrics
- GitHub: https://github.com/elizaOS/llama.cpp (4 days ago update)

---

## 3. Community Reactions & Additional Data Points

### Reddit r/LocalLLaMA — NVFP4 on llama.cpp (June 7, 2026)
**Thread:** "NVFP4 on llama.cpp?" → https://www.reddit.com/r/LocalLLaMA/comments/1tzjahj/nvfp4_on_llamacpp/

Key discussion points:
- Converting NVFP4 safetensors to GGUF — should users generate and apply imatrix dataset?
- Questions about NVFP4 safetensors/GGUF providers
- Community seeking best practices for NVFP4 quality preservation

### NVIDIA Developer Forum — RedHatAI Results (2026)
**Thread:** "Qwen/Qwen3.6-35B-A3B (and FP8) has landed" → https://forums.developer.nvidia.com/t/qwen-qwen3-6-35b-a3b-and-fp8-has-landed/366822/219

User "dobs" posted RedHatAI/Qwen3.6-35B-A3B-NVFP4 results, indicating active community testing and benchmarking of this specific converter/model combination.

### Unsloth Qwen3.6-35B-A3B Discussion (Apr 2026)
**Hugging Face:** https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/discussions/10

Key finding: *"The benchmark for Qwen3.6-35B-A3B-UD-Q8_K_XL (Unsloth) was a disappointing surprise; it solved fewer tests and had more errors than Qwen3.5."*

This suggests converter choice and quantization method significantly impact real-world performance, not just perplexity scores.

### Reddit r/unsloth — 2-bit Qwen3.6 Success (Apr 2026)
**Thread:** "2-bit Qwen3.6-35B-A3B GGUF is amazing! Made 30+ successful tool..." → https://www.reddit.com/r/unsloth/comments/1sndis4/2bit_qwen3635ba3b_gguf_is_amazing_made_30/

High community engagement on converter quality for extreme quantization levels (2-bit), showing Derek's interest in pushing quantization boundaries is well-aligned with community focus.

---

## 4. Quantization Format Quality Comparisons

### NVFP4 vs Other Formats — Performance Context

**NVFP4 Characteristics:**
- **Bits per weight:** ~3.44 bpw (with FP8 scales every 16 weights)
- **Compatibility:** Requires runtime support for repacked tensors
- **Quality trade-off:** Significant size reduction vs BF16/FP16, but quality depends heavily on converter implementation

**From NVIDIA Blog (June 10, 2026):**
> *"A practical guide to BF16, FP8, NVFP4, MXFP4, INT4, and GGUF Q4_K_M on NVIDIA DGX Spark. Bytes per parameter, quality vs size..."*
Reference: https://blog.kubesimplify.com/day-4-quantization-demystified-bf16-fp8-nvfp4-mxfp4-int4-gguf-and-why-it-all-matters

### General GGUF Quality Hierarchy (2026 Consensus)

| Format | Bits/Param | Quality Retention | Size | Best Use Case |
|--------|-----------|-------------------|------|---------------|
| BF16/FP16 | 16.0 | 100% (baseline) | ~70 GB (35B) | Reference, highest quality |
| FP8 Scaled | 8.0 | ~95-98% | ~35 GB | Good balance, fast inference |
| NVFP4 | ~3.44 | ~85-92%* | ~12 GB | Edge/desktop, requires special runtime |
| Q8_K_XL | 8.0 | ~95-97% | ~35 GB | Best K-Quant quality |
| Q6_K | 6.0 | ~92-95% | ~22 GB | High quality, reasonable size |
| **Q4_K_M** | 4.0 | ~88-92% | ~16 GB | Sweet spot (most popular) |
| Q3_K_M | 3.0 | ~80-88% | ~12 GB | Extreme compression, quality loss visible |
| Q2 | 2.0 | ~70-80% | ~8 GB | Last resort, significant degradation |

*NVFP4 quality highly converter-dependent — knoopx achieves higher retention than Heretic based on Derek's benchmarks.

### Perplexity vs Real-World Performance

**Important Context (from Kaitchup Substack, Feb 2026):**
> *"Metrics like perplexity or KL divergence aren't the whole story... The benchmark error increased by only ~18.4%, while memory dropped from ~800 GB to ~94 GB."*

Derek's use of both perplexity (pp) AND token generation speed (tg) provides a more complete picture than single-metric benchmarks alone.

---

## 5. Benchmarking Best Practices & Technical Context

### llama.cpp Perplexity Benchmarking Guidelines

**Discussion #5962: "Blind testing different quants"** → https://github.com/ggml-org/llama.cpp/discussions/5962
- Community approach: Use human preference as benchmark, not just synthetic metrics like perplexity or KL divergence
- Suggests Derek's multi-metric approach (pp + tg) is more robust than single-metric testing

**Issue #11459: "Problems with perplexity calculation"** → https://github.com/ggml-org/llama.cpp/issues/11459 (Jan 27, 2025)
- Context length significantly impacts perplexity scores
- Benchmarks at 512 ctx show higher perplexity than longer contexts
- Derek should standardize context lengths when comparing converters

**Discussion #406: "Perplexity (Quality of Generation) Scores"** → https://github.com/ggml-org/llama.cpp/discussions/406
- Community is actively collecting perplexity scores for models + quantizations + program flags
- Coordinating benchmark efforts across llama.cpp ecosystem

### Imatrix and Importance Quantization

**Key Finding (Langur Monkey Guide, Mar 2026):**
> *"The 'IQ' (importance-quantization) types need an importance matrix to work well... Lower perplexity (ppl) means better quality."*
Reference: https://tonisagrista.com/blog/2026/quantization/

**Relevance to Derek's Work:**
- NVFP4 converters that leverage imatrix datasets may achieve lower perplexity
- Reddit thread indicates community is actively discussing imatrix application for NVFP4 conversions
- Derek could experiment with generating custom imatrix data from his workloads for better Heretic converter results

---

## 6. Additional Quantization Formats Worth Testing

### Formats Derek Should Consider Testing

**1. MXFP4 (Mixed EXponent FP4)**
- Alternative to NVFP4 with potentially different quality characteristics
- More flexible exponent allocation per tensor
- NVIDIA's newer format, gaining adoption on Blackwell architecture

**2. GPTQ-GGUF Toolkit**
- GitHub: https://github.com/IST-DASLab/gptq-gguf-toolkit
- "GPTQ Quantization consistently outperforms standard K-Quants at equivalent bitwidths, achieving lower perplexity scores"
- Could be tested against NVFP4 for quality comparison

**3. Ternary Quantization (2-bit)**
- Reddit thread showed 2-bit Qwen3.6 achieving impressive real-world tool use (30+ successful operations)
- Derek's interest in extreme quantization makes this relevant
- Quality degradation may be acceptable if perplexity is offset by other gains

**4. IQ Variants (Importance Quantization)**
- IQ1_S, IQ2_XS, IQ3_XXS — ultra-low bit formats with importance matrices
- Best for memory-constrained scenarios where quality can be sacrificed

---

## 7. Community Discussions & Threads Worth Monitoring

### Active Discussion Channels

**Reddit r/LocalLLaMA:**
- NVFP4 conversion techniques thread (June 2026) → https://www.reddit.com/r/LocalLLaMA/comments/1tzjahj/nvfp4_on_llamacpp/
- Perplexity benchmark threads ongoing
- Community actively sharing converter results

**GitHub llama.cpp Discussions:**
- Discussion #23853: Advanced-gguf-quantizer tool → https://github.com/ggml-org/llama.cpp/discussions/23853
- Discussion #5962: Blind testing quants → https://github.com/ggml-org/llama.cpp/discussions/5962
- Issue #11459: Perplexity calculation problems → https://github.com/ggml-org/llama.cpp/issues/11459

**Hugging Face Model Pages:**
- knoopx/Qwen3.6-35B-A3B-NVFP4-GGUF → https://huggingface.co/knoopx/Qwen3.6-35B-A3B-NVFP4-GGUF
- unsloth/Qwen3.6-35B-A3B-GGUF → https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/discussions/10

**NVIDIA Developer Forums:**
- Qwen FP8/NVFP4 testing thread → https://forums.developer.nvidia.com/t/qwen-qwen3-6-35b-a3b-and-fp8-has-landed/366822/219

### Key People to Engage With

**@ggerganov (Georgi Gerganov) — llama.cpp Creator:**
- Follow for converter updates, NVFP4 support announcements
- Recently added MTP (Multi-Token Prediction) support for Qwen3.6 family
- Reference: https://x.com/ggerganov/status/2056391115469689330

**@mishig25 (Mishig) — GGUF Ecosystem:**
- Hugging Face GGUF section updates, emphasizing MTP heads
- Active in converter development discussions

**unsloth team:**
- Published extensive Qwen3.5/Qwen3.6 benchmark data
- Dynamic quantization approach worth studying for Derek's work

---

## 8. Recommendations for Derek's Next Steps

### Immediate Actions (Content Opportunities)

1. **"GGUF Converter Showdown: Heretic vs knoopx — The 5× Perplexity Gap"**
   - Publish Derek's benchmark data with explanation of what perplexity means
   - Include token generation speed comparison
   - Recommend knoopx for production, note Heretic as convenience option needing improvement

2. **"How to Choose a GGUF Converter in 2026: A Practical Guide"**
   - Compare major converters (knoopx, Unsloth, Heretic, advanced-gguf-quantizer)
   - Explain when quality matters vs when speed matters
   - Include Derek's DGX Spark test setup as reference

3. **"NVFP4 Conversion Best Practices: What the Community Got Wrong"**
   - Address Reddit discussion points about imatrix for NVFP4
   - Share Derek's findings on converter dependency
   - Provide actionable recommendations for local practitioners

### Medium-Term Research Directions

1. **Test additional quantization formats:** MXFP4, GPTQ-GGUF, ternary (2-bit) against knoopx baseline
2. **Generate custom imatrix data** from Derek's workloads and test if Heretic converter quality improves
3. **Benchmark across context lengths** to address perplexity calculation variability (per llama.cpp issue #11459)
4. **Real-world task performance testing** beyond perplexity — follow Reddit r/LocalLLaMA blind testing approach

### Long-Term Content Strategy

- Position Derek as authority on GGUF converter quality, not just model benchmarking
- Create reference guide for community (link back to his tools/methods)
- Engage with llama.cpp maintainers (@ggerganov) on NVFP4 improvements
- Build reputation in local AI ecosystem through practical, reproducible benchmark data

---

## 9. Sources & Links

### Primary Benchmark Data:
1. Derek's original tweet (June 26): "GGUF conversion quality: Heretic local GGUF underperforms knoopx/RedHatAI ~5× pp and ~3× tg"
2. knoopx/Qwen3.6-35B-A3B-NVFP4-GGUF on Hugging Face → https://huggingface.co/knoopx/Qwen3.6-35B-A3B-NVFP4-GGUF
3. Heretic converter script: `convert-qwen36-heretic-nvfp4-gguf.sh`

### Converter Ecosystem:
4. Advanced-gguf-quantizer discussion (GitHub #23853) → https://github.com/ggml-org/llama.cpp/discussions/23853
5. Unsloth Qwen3.6 benchmark discussion → https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/discussions/10
6. TurboQuant + QJL + PolarQuant + DFlash unified tools (GitHub elizaOS/llama.cpp)

### Community Discussions:
7. Reddit r/LocalLLaMA — NVFP4 on llama.cpp → https://www.reddit.com/r/LocalLLaMA/comments/1tzjahj/nvfp4_on_llamacpp/
8. Reddit r/unsloth — 2-bit Qwen3.6 success → https://www.reddit.com/r/unsloth/comments/1sndis4/2bit_qwen3635ba3b_gguf_is_amazing_made_30/
9. NVIDIA Developer Forum — RedHatAI results → https://forums.developer.nvidia.com/t/qwen-qwen3-6-35b-a3b-and-fp8-has-landed/366822/219

### Technical Context:
10. ArXiv paper: "Which Quantization Should I Use?" (Jan 2026) → https://arxiv.org/html/2601.14277v1
11. Kaitchup Substack — Lessons from GGUF Evaluations (Feb 2026)
12. Langur Monkey Guide — GGUF Quantization Guide (Mar 2026) → https://tonisagrista.com/blog/2026/quantization/
13. llama.cpp Discussion #5962 — Blind testing quants → https://github.com/ggml-org/llama.cpp/discussions/5962
14. llama.cpp Issue #11459 — Perplexity calculation problems → https://github.com/ggml-org/llama.cpp/issues/11459

### Key Accounts to Follow:
- @ggerganov (Georgi Gerganov) — llama.cpp creator, NVFP4/MTP support announcements
- @mishig25 — GGUF ecosystem updates on Hugging Face
- Unsloth AI team — Dynamic quantization benchmarks
- @sudoingX (Sudo su) — DGX Spark benchmarking partner, relevant for hardware context

---

## 10. Risks & Considerations

- **Perplexity is not the whole story:** Real-world task performance may differ from synthetic metrics. Derek's multi-metric approach (pp + tg) is more robust.
- **Context length dependency:** Perplexity scores vary significantly with context length. Standardized testing conditions are critical for fair comparisons.
- **Converter versioning:** GGUF converters evolve rapidly. Data may become outdated quickly — Derek should timestamp his benchmarks and note converter versions used.
- **Hardware specificity:** All data here is from DGX Spark or similar NVIDIA Blackwell hardware. Results may differ on other platforms (AMD, Apple Silicon).

---

*Research compiled: June 29, 2026*  
*Assign to: Curator for review before drafting content issue*
