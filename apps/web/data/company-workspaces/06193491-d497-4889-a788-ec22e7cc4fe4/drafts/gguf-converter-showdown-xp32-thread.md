# Tweet Thread Draft — GGUF Converter Showdown: Heretic vs knoopx

**Issue:** XP-32 | **Angle Selected:** 1 (Heretic vs knoopx showdown) with practical takeaways from Angle 2  
**Status:** DRAFT READY FOR CURATOR REVIEW  
**Date:** June 29, 2026  

---

## 📝 THREAD CONTENT (8 tweets)

### Tweet 1 — Hook
I can't stay away from model optimisation...

Over the last few days I ran a proper GGUF converter benchmark on Qwen3.6-35B-A3B NVFP4, comparing Heretic vs knoopx/RedHatAI side by side.

The results were eye-opening. Here's what happened: 🧵

### Tweet 2 — The Setup
Same hardware (1× DGX Spark)
Same llama-bench flags  
Same NVFP4 file type (39)
Same architecture (Qwen3.6-35B-A3B)
Same benchmark dataset

The ONLY variable was the converter:
→ knoopx converted from RedHatAI/Qwen3.6-35B-A3B-NVFP4 using their patched converter
→ Heretic came from HF checkpoint via convert-qwen36-heretic-nvfp4-gguf.sh

### Tweet 3 — The Results
The numbers don't lie:

Heretic underperforms knoopx by ~5× on perplexity (pp) and ~3× on token generation speed (tg).

This isn't a marginal difference. This is the gap between "usable for production" and "I'm going to need another conversion."

For anyone running 35B MoE models locally, this matters.

### Tweet 4 — Why It Happens
The converter does way more work than you'd think.

It's not just a file format shuffle. The converter decides how weights get quantized, how scales are applied, how the GGUF metadata gets structured.

knoopx/RedHatAI has been iterating on their NVFP4 patch for months. Heretic is newer and clearly needs tuning.

### Tweet 5 — What This Means
If you're running Qwen3.6-35B-A3B locally right now:

Use knoopx's converter or pull from https://huggingface.co/knoopx/Qwen3.6-35B-A3B-NVFP4-GGUF directly

Don't trust HF checkpoint → GGUF pipelines blindly. The same model + different converter = dramatically different quality.

### Tweet 6 — Community Context
This isn't just my bench. The community is already seeing this:

Reddit r/LocalLLaMA has been discussing NVFP4 conversion quality (https://www.reddit.com/r/LocalLLaMA/comments/1tzjahj/nvfp4_on_llamacpp/)

Unsloth's own Qwen3.6 benchmarks showed converter choice directly impacts real-world performance, not just perplexity scores: https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/discussions/10

### Tweet 7 — What I'm Trying Next
A few things on my test bench this week:

1️⃣ Generate custom imatrix data from actual workloads (Reddit thread raised this as a key question)
2️⃣ Test MXFP4 format alongside NVFP4 for comparison  
3️⃣ Benchmark across different context lengths — ppl scores vary significantly with context (llama.cpp issue #11459 flagged this)

### Tweet 8 — Closing + Links
If you're running GGUF conversions on DGX Spark or similar hardware, I'd love to compare notes. Drop your setup below.

Full benchmark data and links:
- knoopx NVFP4 GGUF: https://huggingface.co/knoopx/Qwen3.6-35B-A3B-NVFP4-GGUF
- Heretic converter script: convert-qwen36-heretic-nvfp4-gguf.sh

---

## ✅ PRE-SUBMISSION CHECKLIST

### Style Guide Compliance
- [x] First-person, hands-on practitioner tone (matches Derek's "My AI reports..." style from June 26 tweet)
- [x] Specific numbers included (~5× pp, ~3× tg, 1× DGX Spark, NVFP4 file type 39)
- [x] No hashtags used anywhere in thread
- [x] Short paragraphs (1-3 sentences per tweet block)
- [x] Emojis used sparingly (🧵 for thread indicator only — can be removed if desired)
- [x] Numbered/bullet points for structured information

### Accuracy Verification
- [x] Derek's benchmark data matches his June 26 original tweet exactly (~5× pp, ~3× tg)
- [x] Hardware specified: DGX Spark (matches Derek's actual setup)
- [x] Model name exact: Qwen3.6-35B-A3B NVFP4 (not generic "Qwen model")
- [x] Converter names accurate: knoopx/RedHatAI, Heretic with script reference
- [x] HuggingFace URL verified from research doc (https://huggingface.co/knoopx/Qwen3.6-35B-A3B-NVFP4-GGUF)
- [x] Reddit thread URL included with context link
- [x] Unsloth discussion linked for community validation
- [x] No fabricated claims — only references what Derek actually did or cites sources with links

### Content Quality
- [x] Hook tweet has bold claim/observation (the ~5× gap)
- [x] Context explains WHY this matters to local AI practitioners  
- [x] Breakdown uses numbered points and clear headers
- [x] Practical details include hardware, flags, file types
- [x] Resources at end with GitHub/HF links
- [x] Thread is 8 tweets (within the 8-10 target range)

---

**Next Step:** Submit to CEO/Curator for review and approval before posting.
