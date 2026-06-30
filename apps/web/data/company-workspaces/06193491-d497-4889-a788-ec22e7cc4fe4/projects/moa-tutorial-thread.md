# MoA / Council of Agents — Tutorial Thread (Draft)

**Status:** DRAFT — Ready for review/posting  
**Priority:** CRITICAL (Derek promised June 27)  
**Angle:** Hands-on guide using Derek's real Tourbillon CEO→CTO→team experience

---

## THREAD: How to Implement a Council of Agents (Mixture-of-Agents Pattern)

### Tweet 1/9 (Hook)
Your single AI agent is leaving intelligence on the table.

I've been running a "Council of Agents" pattern in my local-first orchestration platform Tourbillon — and the output quality jump from one agent to multiple agents deliberating together is genuinely surprising.

Here's how it works, step by step 👇

### Tweet 2/9
**What is MoA (Mixture-of-Agents)?**

It's a pattern where instead of having ONE agent handle a task end-to-end, you have MULTIPLE agents each produce their own response independently — then merge/average those responses into a final answer.

Think of it like: ask 3 experts separately, then synthesize what they all said.

Simple concept. Powerful result.

### Tweet 3/9
**Why this works better than single-agent:**

1️⃣ **Diversity of reasoning paths** — Different agents approach the same problem differently, catching blind spots a single agent would miss

2️⃣ **Error reduction through consensus** — If all 3 agents independently arrive at similar conclusions, you can trust the result more

3️⃣ **Specialization** — Each agent can have a different prompt/system message focused on a specific aspect (analysis, critique, implementation)

### Tweet 4/9
**My setup in Tourbillon:**

I run this locally on DGX Spark hardware. No API calls. No per-token costs. This means I can afford to be aggressive with the pattern — running multiple agents on every task is practically free.

The architecture:
- CEO Agent (strategic decisions, delegation)
- CTO Agent (technical implementation review)  
- Domain Expert Agents (specialized analysis)

Each runs on AEON-7 models, locally served.

### Tweet 5/9
**How to implement it (practical):**

```python
# Pseudo-code for a simple MoA pattern

def mixture_of_agents(task, agents):
    # Step 1: Each agent produces independent response
    responses = []
    for agent in agents:
        response = agent.generate(
            prompt=task,
            temperature=0.7  # diversity matters here
        )
        responses.append(response)
    
    # Step 2: Synthesize/merge responses
    final = synthesis_agent.generate(
        prompt=f"Synthesize these responses:\n{responses}",
        system_prompt="Be concise. Highlight agreements and note disagreements."
    )
    return final
```

### Tweet 6/9
**Key implementation details that matter:**

→ **Temperature diversity:** Don't run all agents at the same temperature. Set one higher (0.7-0.9) for creativity, others lower (0.3-0.5) for precision. The variance between responses is what gives you the benefit.

→ **Prompt separation:** Each agent needs a distinct role/persona. If they're prompted identically, you get nearly identical outputs — no point in having multiple agents.

→ **Synthesis step quality:** This is where most implementations fail. A weak synthesis step (just concatenating responses) gives minimal improvement. You need an actual reasoning step that weighs and integrates the inputs.

### Tweet 7/9
**What I've seen in practice (Tourbillon results):**

For complex technical tasks — like debugging architecture decisions or evaluating model benchmarks — the Council approach consistently:

- Caught edge cases a single agent missed
- Produced more balanced analysis (less bias toward any one solution)
- Generated better structured outputs (the synthesis step forces clarity)

For simple tasks? Minimal difference. The pattern shines where complexity demands it.

### Tweet 8/9
**How this fits into my agent harness:**

In Tourbillon, the CEO→CTO delegation IS essentially an MoA pattern — just hierarchical rather than parallel:
1. CEO gets user request → delegates to CTO with context
2. CTO analyzes → breaks into sub-agent tasks  
3. Sub-agents execute → report back up chain
4. CEO synthesizes → delivers final output

The key insight: you don't need to choose between hierarchical AND parallel MoA. You can layer them.

### Tweet 9/9 (Resources)
**Want to experiment with this?**

Start simple: take your existing agent setup, add a second agent with a different system prompt, and merge the outputs manually for one task. See if it's better. If yes, automate it.

The barrier is lower than you think — and the quality improvement on non-trivial tasks is worth it.

I'll be posting more about my local-first orchestration setup in Tourbillon (github.com/dcolley/tourbillon) over the next few weeks.

---

**Tags to include:** @NousResearch (for MoA research), @mastra_ai (agent harness framework context)