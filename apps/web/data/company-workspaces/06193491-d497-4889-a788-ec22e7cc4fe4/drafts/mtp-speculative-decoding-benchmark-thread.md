# Tweet Thread: MTP Speculative Decoding on MoE Models — Benchmark Roundup

## Hook (Tweet 1)

ggerganov just called multi-token prediction a "significant milestone" for local AI. but does it actually help moe models like qwen3.6-35b-a3b? i ran through all the community benchmarks so you don't have to. here's what the data says (spoiler: mixed). 🧵

## Context (Tweet 2)

first, why this matters: qwen3.6-35b-a3b is my go-to model on dgx spark. fast, capable, runs at like 80+ tok/s stock. but speculative decoding promises even more speed by predicting multiple tokens ahead. the question is — does it work when most of the params are already "off"?

## The Good News (Tweet 3)

rtx 5060 ti results — +47% speedup:
- qwen3.6-35b-a3b went from 98 t/s → 144 t/s with mtp draft-2
- source: https://njannasch.dev/blog/mtp-speculative-decoding-qwen-3-6-5060ti/

that's a solid gain. if you're on a 5060 ti, this is worth trying. key flags: --spec-type draft-mtp --spec-draft-n-max 2

## The Complication (Tweet 4)

rtx 3090 results — mixed/no improvement:
- some tests showed zero net speedup with llama.cpp + q4
- the a3b moe model has 35b total params but only ~3b active per token
- speculative decoding works by trading idle compute for speed — on moe models, there's less "idle" to trade

source: https://hackmd.io/ODXuOQNzSiyUITz7g9mtBw

## vLLM Results (Tweet 5)

vllm with matched flags showed +27.5% faster decode rate with mtp k=1 (n=5 trials × 5 prompts). so the framework matters — vllm handles moe better than llama.cpp for this workload apparently.

source: https://github.com/thc1006/qwen3.6-speculative-decoding-rtx3090

## SpaceTimeViking's DFlash (Tweet 6)

speaking of space-time-viking, he mentioned getting dflash working on ornith models with 200-300% performance over stock. that's a speculative decoding technique optimized for blackwell architecture — could be game-changing if it holds up across more models.

## What This Means for Derek (Tweet 7)

i think the next logical step is to run my own dgx spark benchmarks with mtp enabled vs disabled. same model, same quantization, different flags. the results will either confirm or challenge this community data.

expect a follow-up thread with actual numbers from the spark in ~3 days. if you want me to test anything specific, drop it below.

## Resources (Tweet 8)

for anyone wanting to try this yourself:
- ggml-org qwen3.6-35b-a3b-mtp gguf: https://huggingface.co/ggml-org/Qwen3.6-35B-A3B-MTP-GGUF
- rtx 5060 ti benchmark: https://njannasch.dev/blog/mtp-speculative-decoding-qwen-3-6-5060ti/
- rtx 3090 mixed results: https://hackmd.io/ODXuOQNzSiyUITz7g9mtBw
- github benchmark repo: https://github.com/thc1006/qwen3.6-speculative-decoding-rtx3090

---

**Notes for posting:**
- Post as a thread (8 tweets)
- Links should be clickable — ensure they don't get truncated by keeping them at end of tweets where possible
- Consider pinning the thread to the profile
- Tag: @ggerganov in tweet 1 or 2 for visibility
