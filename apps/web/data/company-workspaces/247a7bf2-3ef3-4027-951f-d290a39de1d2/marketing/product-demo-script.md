# Tourbillon — Product Demo Script

*Last Updated: 2026-06-26 · Version 1.0 (Draft)*  
**Prepared for:** Sales, Marketing, and Customer Success teams  
**Classification:** Internal Use  

---

## Table of Contents

1. [Overview & Timing](#overview--timing)
2. [Introduction — The Hook](#introduction--the-hook)
3. [Key Features Demonstration](#key-features-demonstration)
4. [Use Cases in Action](#use-cases-in-action)
5. [Competitive Positioning](#competitive-positioning)
6. [Pricing & Getting Started](#pricing--getting-started)
7. [Call to Action](#call-to-action)
8. [FAQ Cheat Sheet for Demo Q&A](#faq-cheat-sheet-for-demo-qa)

---

## Overview & Timing

| Segment | Duration |
|---------|----------|
| Introduction & Hook | 2 minutes |
| Key Features Walkthrough | 10 minutes |
| Use Case Demonstrations | 8 minutes |
| Competitive Positioning (if relevant) | 3 minutes |
| Pricing & Next Steps | 2 minutes |
| Q&A | 5–10 minutes |

**Total:** ~30-minute demo, adjustable based on prospect interest.

**Demo Environment Checklist (before calling):**
- [ ] Tourbillon platform is live and accessible at `tourbillon.io`
- [ ] Demo account has a pre-built sample workspace ready
- [ ] Sample agents are configured and active
- [ ] Authentication flows (Google/GitHub OAuth, email) all work
- [ ] Integrations (Slack, GitHub, Notion, Google Drive) connected for demo
- [ ] Pricing page reflects current tiers

---

## Introduction — The Hook

### Opening Statement (30 seconds)

> *"Imagine you could build a fully autonomous team of AI workers — each with their own specialty — and orchestrate them together on complex workflows. No coding required. Not months of development, not a consulting engagement. Minutes.*
>
> *That's Tourbillon."*

### The Problem We Solve (1 minute)

Most teams today face one of these problems:

1. **AI tools are either too simple or too complex.** Zapier handles basic automations but can't reason. LangChain and CrewAI offer real power — but they require deep coding expertise, and your operations team is locked out.
2. **You're stuck with single-agent assistants.** Copilot helps one person be more productive. But what about workflows that need multiple AI specialists collaborating on a single problem?
3. **Prototypes never reach production.** Teams spend weeks building agent prototypes in notebooks and scripts — then the infrastructure, scaling, monitoring, and deployment nightmare stops them.

**Tourbillon solves all three.** We're the only platform that combines visual multi-agent orchestration with enterprise-grade security and zero-infra deployment — from prototype to production in one seamless workflow.

---

## Key Features Demonstration

### Feature 1: Visual Agent Orchestration Builder

**Narration:**
> *"Let me show you the Tourbillon canvas. This is where workflows come to life.*
>
> *On the left, we have our agent library — pre-built agents for common tasks like content review, data analysis, customer support triage, or code generation. Each one can be customized with its own prompt, tools, and guardrails.*
>
> *Drag an agent onto the canvas. Connect it to another agent with a simple line. Define what each agent does, when they act, and how they communicate.*
>
> *That's it — no code, no boilerplate, no configuration files."*

**Demo actions:**
1. Open or create a new workspace/project.
2. Show the agent library sidebar (pre-built agents).
3. Drag two agents onto the canvas.
4. Draw a connection between them (showing the handoff).
5. Point out that the non-technical team members could do this themselves.

**Key soundbite:** *"This is where your PMs, ops teams, and subject matter experts can design workflows without waiting for an engineering ticket."*

---

### Feature 2: Multi-Agent Handoff & Reasoning

**Narration:**
> *"Now watch what happens when these agents collaborate.*
>
> *In this example, we have a customer support triage workflow. Agent A receives incoming tickets and analyzes sentiment and urgency using AI reasoning. If the issue is straightforward, it resolves it directly. If not — it hands off to Agent B (a specialized escalation agent) with full context.*
>
> *The handoff isn't just passing data. It's passing intent, confidence scores, and recommended actions. The next agent picks up exactly where the previous one left off."*

**Demo actions:**
1. Open the pre-built "Customer Support Triage" sample project/template.
2. Walk through the workflow visually — show Agent A → conditional logic → Agent B or resolution.
3. Trigger a simulated incoming ticket (use a test workflow if needed).
4. Show the agent activity feed as tasks are assigned, completed, and escalated in real time.

**Key soundbite:** *"This isn't rule-based automation. These agents reason about each step before acting."*

---

### Feature 3: Human-in-the-Loop Control

**Narration:**
> *"Autonomy is powerful, but businesses need oversight. Tourbillon gives you human-in-the-loop checkpoints built right in.*
>
> *At any point in a workflow — after an agent completes analysis, before it sends a customer email, before it commits code to production — you can place an approval gate.*
>
> *The team gets notified. They review, approve with one click, or send back feedback for the agent to revise. No manual intervention required when things go right."*

**Demo actions:**
1. Open a workflow with an embedded human-in-the-loop node (e.g., "Approval Required: Customer Response").
2. Show the notification/alert mechanism.
3. Click through an approval — show the workflow resuming automatically after approval.
4. Optionally demonstrate a rejection scenario where the agent revises and resubmits.

**Key soundbite:** *"Full autonomy with full control. Your team stays in the loop without being bottlenecked by it."*

---

### Feature 4: Enterprise-Grade Security & Compliance

**Narration:**
> *"Tourbillon was built for teams that can't afford to cut corners on security.*
>
> *Every workspace has role-based access control — Admin, Editor, Viewer. Every action is logged in a comprehensive audit trail. All data is encrypted at rest and in transit. We're SOC 2 ready out of the box and fully GDPR/CCPA compliant."*

**Demo actions:**
1. Navigate to Settings → Team & Members — show RBAC roles (Admin, Editor, Viewer).
2. Show an invite flow for a new team member.
3. Briefly point to the audit log / activity feed showing tracked actions.
4. Reference that data is encrypted (no deep technical demo needed unless the prospect asks).

**Key soundbite:** *"Your data stays yours. Security isn't a bolt-on — it's baked into every layer of Tourbillon."*

---

### Feature 5: Deploy & Monitor in Real-Time

**Narration:**
> *"Once your workflow is designed, tested, and approved — deploy with one click.*
>
> *Tourbillon handles all the infrastructure: auto-scaling, load balancing, error monitoring. You get a unified dashboard showing every agent's activity, performance metrics, and any errors that occur.*
>
> *If something goes wrong, you see it immediately — not from an angry customer email."*

**Demo actions:**
1. Open the deployed workflow view.
2. Show the real-time monitoring dashboard (agent status, active tasks, error rates).
3. Point out any alert/notifications if a test agent triggers one.
4. Mention that scaling happens automatically — no manual infrastructure management.

**Key soundbite:** *"One click from prototype to production. The platform scales with you."*

---

## Use Cases in Action

### Use Case 1: Operations — Automated Content Review Pipeline

> *"Let's walk through a real-world scenario for an operations team managing content workflows.*
>
> *Here we have a marketing team that produces blog posts, social media content, and product updates. Each piece needs writing → review by SME → legal compliance check → scheduling for publication.*
>
> *In Tourbillon:*
> - *Agent A drafts content based on briefs*
> - *Agent B (SME reviewer) evaluates accuracy and quality — human-in-the-loop checkpoint before approval*
> - *Agent C checks against brand guidelines and legal requirements automatically*
> - *Agent D schedules publication to the right channels via integrations with Slack, Notion, Google Drive*
>
> *What used to take three team members and four meetings now happens autonomously. The only human touch is the SME review — everything else flows automatically."*

**Time:** ~3 minutes

---

### Use Case 2: Customer Support — Intelligent Triage & Resolution

> *"For customer support teams, Tourbillon transforms ticket handling.*
>
> *Incoming tickets are analyzed by Agent A for intent and urgency. Low-priority questions get resolved automatically using the knowledge base. Medium-priority issues get routed to human agents with suggested responses. High-priority or complex issues escalate to a specialist agent that can pull data from multiple sources, draft a resolution, and wait for human approval before responding.*
>
> *The result? Faster response times, consistent quality, and your best humans working on the hardest problems."*

**Time:** ~3 minutes (can be extended if prospect is in customer support)

---

### Use Case 3: Product Management — Automated Feedback Pipeline

> *"Product teams drowning in user feedback can use Tourbillon to automate collection, analysis, and prioritization.*
>
> *Agent A collects feedback from all sources — app feedback forms, reviews, community forums. Agent B categorizes and analyzes themes using NLP. Agent C maps findings against your product roadmap goals. The output? A weekly priority report that's actionable, not just a pile of comments."*

**Time:** ~2 minutes (optional — use if prospect mentions PM challenges)

---

## Competitive Positioning

> *"You might be asking — how is Tourbillon different from what you're using today?*
>
> **If they use Zapier or Make:** *"Those tools are great for simple task automation between apps. But they can't reason, decide, or adapt. Tourbillon adds an AI intelligence layer on top — your agents don't just execute rules, they think about the problem and make decisions."*

**If they're developers using CrewAI/LangChain:** *"Those frameworks are powerful but built for engineers. With Tourbillon, you get the same multi-agent capability visually — without writing boilerplate code. Your engineers prototype 10x faster, and your non-technical team members can design workflows themselves."*

**If they use Copilot/Duet AI:** *"Great tools for individual productivity. But they're single assistants working alone. Tourbillon orchestrates multiple specialized agents collaborating on complex business processes — like having an entire team of AI experts, not just one helper."*

> *The bottom line: if your workflow needs intelligence AND collaboration beyond a single task chain — that's where Tourbillon wins.*"

**Time:** ~3 minutes (use selectively based on prospect's current stack)

---

## Pricing & Getting Started

### Free Tier
- Up to 5 active agents
- Community support
- Shared compute resources
- Perfect for prototyping and learning

> *"You can sign up right now at tourbillon.io — no credit card required, no setup. Get a workspace up and running in under five minutes."*

### Pro Tier (Coming Soon)
- Unlimited agents
- Priority support
- Dedicated compute resources
- Advanced analytics and monitoring

### Enterprise (Contact Us)
- Custom SLA
- VPC/private deployment options
- SSO and RBAC integration
- Dedicated account management

---

## Call to Action

> *"Here's what I'd suggest as next steps:*
>
> **If you're curious:** Sign up for the free tier at tourbillon.io, explore our template library, and try building your first workflow. It takes minutes, not days.
>
> **If you have a specific use case in mind:** Let me set up a follow-up call where we walk through how Tourbillon would solve [their exact problem]. We can build a custom demo together using your real workflows.
>
> **If you're an enterprise team evaluating options:** I'd love to connect with our solutions engineering team to discuss your requirements, security posture, and deployment model."*

---

## FAQ Cheat Sheet for Demo Q&A

| Question | Quick Answer |
|----------|-------------|
| *What is Tourbillon?* | Open-source AI agent orchestration platform. Design multi-agent workflows visually, deploy with one click. Zero coding required for standard workflows. |
| *Do I need to code?* | No. The visual builder handles everything. Advanced users can customize agents via settings if they want deeper control. |
| *How is this different from Zapier?* | Zapier runs predefined rules. Tourbillon's agents reason, make decisions, and adapt — it's AI-powered workflow orchestration, not just automation. |
| *Can non-technical teams use it?* | Yes. The drag-and-drop canvas is designed for PMs, ops, and business users — not just developers. |
| *What about data security?* | SOC 2 ready, RBAC, audit trails, encryption at rest/in transit, GDPR/CCPA compliant out of the box. |
| *Can I try it for free?* | Yes — free tier with up to 5 active agents. No credit card required. Sign up at tourbillon.io. |
| *What integrations are available?* | Slack, GitHub, Notion, Google Drive, and custom API/webhook support for any tool. |
| *How do I get started?* | Visit tourbillon.io → sign up → pick a template or build from scratch. First workflow in minutes. |

---

*This demo script is a living document. Update it as Tourbillon's features, pricing, and market positioning evolve. Review quarterly with Sales and Marketing leadership.*