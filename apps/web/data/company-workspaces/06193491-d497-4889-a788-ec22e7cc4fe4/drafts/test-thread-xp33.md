# Test Thread — XP-33

## Hook (Post 1)

Just benchmarked Qwen 3.6 35B-MoE on a single DGX Spark at home.

27 tok/s with unsloth, running warm while the agent harness churns through prompts all night.

The thing that surprised me isn't the speed — it's how well it handles multi-turn reasoning without degrading.

Here's what I learned: 🧵

## Post 2

1️⃣ Memory doesn't collapse on long threads like most open-weight models do. Ran a 40-turn diagnostic session and the model still referenced context from turn 3. That's unusual for a 35B parameter model at this scale.

2️⃣ Quantisation matters more than you'd think. Swapped from Q4_K_M to Q3_K_M — dropped about 4 tok/s but saved ~1.2GB VRAM that freed up room for a larger context window. Trade-off was worth it for the harness workload.

## Post 3

3️⃣ The real win: running this locally means zero latency between agent decisions. No API calls, no rate limits, no "model unavailable" errors at 2am when your autonomous pipeline is mid-execution.

If you're still shipping every request to a cloud endpoint for a model that fits comfortably on a $1.5k box... you're burning cash and adding latency for nothing.

Happy to share my full config if anyone wants to replicate these numbers.
