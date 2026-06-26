# Tourbillon Onboarding Email Sequence

## Overview
3-email automated onboarding sequence triggered by user signup timestamps. Delivers progressive value to new users while building engagement and collecting feedback before churn risk increases.

---

## Email 1: Welcome + Quick Start Guide
**Trigger:** Immediately after signup  
**Delay:** Send at T+0 (immediately)  
**Priority:** HIGH - Sets first impression  

### Subject Line Options (A/B test recommended):
- Primary: "Welcome to Tourbillon! Here's your quick start guide 🚀"
- Alternative: "Your Tourbillon account is ready — let's get started!"

### Body Copy:
```markdown
Hi {{user.first_name}},

Welcome aboard! We're thrilled to have you in the Tourbillon community.

Within 5 minutes, you'll be able to:
1. Connect your first AI agent (GitHub OAuth or Google login)
2. Set up your initial goal and project structure
3. Invite a teammate to collaborate on your first workspace

**👉 Your Quick Start Checklist:**
- [ ] Complete your profile setup
- [ ] Create your first project: {{cta_button_link}}/projects/new
- [ ] Try the agent playground: {{cta_button_link}}/playground

Our docs have everything you need: [Getting Started Guide]({{docs_url}})

Need help? Reply to this email or hit us up in our community forum.

Happy building!  
The Tourbillon Team
```

### CTA Button: "Start Building Your First Project" → `/projects/new`
### Secondary Link: "Browse the Docs" → `{{docs_url}}`

---

## Email 2: Key Features Walkthrough (Day 2)
**Trigger:** Day 2 after signup  
**Delay:** Send at T+48 hours if user hasn't created a project yet. If they have, send at T+72 hours highlighting advanced features.  

### Subject Line Options:
- Primary: "3 Tourbillon features you're not using yet (but should be)"
- Alternative: "Unlock the power of AI agents in Tourbillon"

### Body Copy:
```markdown
Hi {{user.first_name}},

It's been a couple days since you joined — hope things are going well! We noticed you haven't explored these features yet, and they could save you serious time:

**1. Agent Configuration Builder**  
Define exactly what each AI agent does with custom prompts, tool selections, and goal hierarchies. → [Configure Your Agents]({{agent_config_url}})

**2. Goal-Project Linking**  
Map your company OKRs to specific projects and track progress in real-time. Our docs walk you through the process: → [Goal Management Guide]({{goal_guide_url}})

**3. Deployment Pipeline Setup**  
One-click deployment with zero-downtime releases, rollback support, and environment variable management. → [Deployment Docs]({{deployment_url}})

Pro tip: The Agent Configuration page is where the magic happens. Start simple (one agent, one goal) and iterate from there.

Questions? Hit reply — we monitor every response within 4 business hours.

Best,  
The Tourbillon Team
```

### CTA Button: "Explore Advanced Features" → `/agent-config`
**Conditional Logic:** If user has already created ≥1 project → replace CTA with "Invite Your Team to Collaborate" → `/projects/{{first_project_id}}/members`

---

## Email 3: Feedback Solicitation (End of Week)
**Trigger:** Day 7 after signup  
**Delay:** Send at T+168 hours  
**Conditional Logic:** Only send if user has been active in the last 48 hours. If inactive, trigger a "We miss you" win-back sequence instead.  

### Subject Line Options:
- Primary: "How's Tourbillon working for you? (2-minute survey)"
- Alternative: "Help us make Tourbillon better for users like you"

### Body Copy:
```markdown
Hi {{user.first_name}},

You've been with Tourbillon for a week now — we'd love to hear how it's going!

**Quick question:** How likely are you to recommend Tourbillon to a colleague or friend? (0 = not likely, 10 = extremely likely)

👉 [Take our 2-minute survey]({{nps_survey_url}})

Your feedback directly shapes what we build next. We read every response and prioritize accordingly.

If you're hitting roadblocks or have questions, please reply to this email — I'll personally make sure it gets resolved quickly.

Thanks for being an early Tourbillon user! 🙏

Best,  
{{support_agent_name}}  
Product Success Manager, Tourbillon
```

### CTA Button: "Take 2-Minute Survey" → `{{nps_survey_url}}` (links to TOUR-61 NPS integration endpoint)
**Conditional Branching:** If user responds with score ≤6 → trigger support ticket auto-creation + immediate human outreach within 1 hour.

---

## Email Provider Integration Notes
- **Provider:** Selected during launch prep (recommend Resend or Postmark for API-first delivery, reliability at scale <10k emails/mo)
- **Templates:** Stored in email provider dashboard; variables populated via backend API call on trigger events
- **Tracking:** UTM parameters on all links + open/click tracking enabled for deliverability monitoring
- **Fallback:** If email provider unavailable → store emails in user inbox queue (`apps/web/src/app/api/inbox/route.ts`) and retry every 15 minutes with exponential backoff

---

## Implementation Checklist (TOUR-68)
- [ ] Create email templates in selected provider (Resend/Postmark/Mailgun)
- [ ] Implement trigger endpoint: `POST /api/onboarding/email-trigger` 
- [ ] Connect triggers to signup events and activity timestamps
- [ ] Set up Day 2 conditional logic (project creation check)
- [ ] Set up Day 7 conditional logic (active user check + NPS survey link)
- [ ] Implement detractor detection (score ≤6) → auto-support ticket creation
- [ ] A/B test subject lines: Primary vs Alternative variants
- [ ] Monitor open rates and click-through rates; report weekly to CEO