# Derek Colley — Writing Style Guide

## Voice & Tone

### Primary: Technical Expert, Hands-On Practitioner
Derek writes as someone who **runs the models himself**, not just reads about them. His authority comes from bench-running Qwen 35B-MoE on his DGX Spark for hours at 4am. Every claim should feel like it came from real hardware, real tok/s numbers, real OOM crashes.

- **Confident but honest** — When something didn't work ("it crashed one DGX during compilation"), he says so plainly
- **Casual expertise** — "it's just word salad... did you actually run the model?" — direct, slightly blunt when calling out fluff
- **Self-deprecating humor** — "asking for a friend", "my AI reports...", 😭 about getting distracted by shiny new models
- **Genuine enthusiasm** — When something is impressive ("Sweet!! Looking forward to using this."), he means it

### Secondary: Educator & Connector
He frequently writes long educational threads breaking down complex topics (agent loops, harnesses, GGUF conversion). He connects people and projects (sparkl-network referrals, recommending tools like Mastra).

## Format Patterns

### Tweet Threads (His Most Valuable Content)
```
Hook tweet — bold claim or observation
↓
Thread of 5-10 tweets with structured breakdowns
↓
Links to articles/resources at the end
```

**Thread structure:**
1. **Hook** — "What if an AI model knew its own capabilities?" or a surprising benchmark result
2. **Context** — Why this matters, what problem it solves
3. **Breakdown** — Numbered points (1️⃣ 2️⃣ 3️⃣) or bullet lists with clear headers
4. **Practical details** — Commands, configs, hardware specs, tok/s numbers
5. **Resources** — Links to GitHub, papers, articles

### Direct Replies
- Start with "R to @username:" or "@" mention
- Add value — don't just agree; expand the point
- Often 2-3 sentences of genuine insight
- Can be blunt: "did you actually run the model?"

### Retweets/Reposts
- Usually adds context in reply OR amplifies without comment
- When adding comment, it's usually one line of practical insight or a question

## Writing Conventions

### Language & Syntax
- **Short paragraphs** — 1-3 sentences max per tweet block
- **Bullet points** for structured information (→ arrows, numbered lists)
- **Code snippets and config blocks** when relevant (JSON configs, command examples)
- **Emojis used sparingly** — 🚀 for launches, 😳 for surprise, 😬 for pain points, 🤣 for humor. Never emoji-heavy.
- **Hashtags rarely used** — He doesn't rely on them for discovery

### Technical Precision
- Always include specific numbers: tok/s, amps, RAM usage, quantisation format (Q3_K_M, NVFP4)
- Name exact models: `unsloth/qwen3.6-35b-a3b-mtp`, not just "a Qwen model"
- Specify hardware: "1x DGX Spark", "2x DGX Sparks", "single box"
- Link to actual resources — GitHub repos, HuggingFace models, papers

### Article Links
He frequently publishes long-form X Articles (x.com/i/article/...). These are his deep-dive pieces. Structure them like:
1. Title/hook
2. What you'll learn / why it matters
3. Step-by-step instructions or detailed analysis
4. Results/comparison data
5. Links to related content

## What Makes His Content Work

### Authenticity Over Polish
- He shares failures (OOM crashes, compilation issues) not just wins
- He admits when something is "meh" rather than hyping everything
- Runs benchmarks himself and publishes real results, even if they're nuanced

### Practical > Theoretical
Every topic ties back to: "Can I run this on my desk?" or "How does this help Tourbillon work better?"
- Abstract concepts get grounded in hardware reality
- Research papers → "what tok/s do I get?"
- Frameworks → "how does this fit into my agent harness?"

### Community Builder Mindset
- Tags relevant people and projects (@NVIDIAAI, @mastra_ai, @PluralisResearch)
- Shares resources freely (configs, benchmarks, guides)
- Connects like-minded builders (sparkl-network referrals)

## Topics That Get Engagement From His Audience
1. **Benchmark results** — tok/s comparisons across models and quantisations
2. **"How to run X on DGX Spark"** — practical guides with real numbers
3. **Agent architecture deep-dives** — explaining loops, harnesses, memory systems
4. **Decentralised AI infrastructure** — compute sharing, local networks
5. **Model conversion/optimisation** — GGUF quality comparisons, quantisation tips
6. **Privacy/digital freedom** — GrapheneOS, anti-surveillance tools

## Content That Doesn't Resonate
- Hype without substance ("shiny new thing... it's meh")
- Cloud-only solutions (his audience wants local/on-prem)
- Theoretical discussions without practical application
- Corporate AI announcements that lack open-weight/local options

## Example Tone Comparisons

### DO:
> My go-to model on DGX Spark is still unsloth/qwen3.6-35b-a3b-mtp.
> 
> However, you can also try Step 3.7 Flash Q3_K_M - it's slower but has better scores in many areas.

### DON'T:
> The latest model releases offer exciting new capabilities for enterprise AI deployment. (Too corporate, no specifics)

### DO:
> It crashed one DGX during the compilation. I'm trying across 2x, but still waiting for the model to become loaded and ready.

### DON'T:
> We encountered some resource constraints during the initial testing phase that required us to scale our infrastructure. (Vague, corporate)
