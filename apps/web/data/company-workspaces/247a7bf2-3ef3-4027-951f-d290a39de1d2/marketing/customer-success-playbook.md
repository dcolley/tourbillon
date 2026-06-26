# Tourbillon — Customer Success Playbook for Retention & Expansion

*Last Updated: 2026-06-26 · Version 1.0 (Draft)*  
**Classification:** Internal Use / Customer Success Team Reference  

---

## 📋 Table of Contents

1. [Purpose & Objectives](#purpose--objectives)
2. [Onboarding Best Practices](#onboarding-best-practices)
3. [Health Check Framework](#health-check-framework)
4. [Escalation Procedures](#escalation-procedures)
5. [Renewal & Expansion Strategies](#renewal--expansion-strategies)
6. [Churn Prevention Playbook](#churn-prevention-playbook)
7. [Metrics & KPI Dashboard](#metrics--kpi-dashboard)

---

## 🎯 Purpose & Objectives

This playbook establishes the customer success framework to maximize retention, drive expansion revenue, and reduce churn across Tourbillon's subscriber base.

### Key Metrics We Own:
| Metric | Target | Owner |
|--------|--------|-------|
| Net Revenue Retention (NRR) | >120% | CS Lead |
| Gross Retention Rate | >95% (Year 1) | CS Team |
| Time-to-First-Value (TTFV) | <48 hours post-signup | Onboarding Flow |
| Customer Health Score | >75/100 average | Automated Tracking |
| Expansion Revenue (% of total) | >30% by Year 2 | CS + Sales |

---

## 🚀 Onboarding Best Practices

### Day 0–1: Immediate Engagement (TTFV <48h Goal)

**Automated Actions:**
- Welcome email within 5 min of signup with personalized getting-started guide
- In-app guided tour of the visual workspace builder (3-step interactive tutorial)
- Pre-built "starter workflow" template pushed to every new user's dashboard
- Link to community forum + FAQ document (`marketing/faq-draft.md`)

**Human Touchpoints:**
- **New Pro Team (5+ seats):** Auto-schedule 1:1 onboarding call within first week. Agenda: workspace setup, team permissions intro, first workflow walkthrough.
- **Enterprise Signups:** Dedicated CSM assigned day-of. Include stakeholder kickoff meeting with IT/security requirements gathering.

### Week 1–2: Habit Formation

**Checklist for CS Team:**
- [ ] Confirm user has created ≥1 active workflow by Day 7
- [ ] Send "midway check-in" email asking about pain points / blockers
- [ ] Identify power users — flag for community ambassador program
- [ ] For teams with <50% seat utilization: proactive outreach to understand why

### Month 1: Value Realization

**Milestone Review (Day 30):**
- Review workflow automation metrics: how many manual tasks were saved?
- Survey: "Did Tourbillon solve your core problem?" (NPS-style)
- If NPS ≤6 at Day 30 → flag for immediate CS intervention
- If NPS ≥9 → request testimonial or case study participation

---

## 📊 Health Check Framework

### Automated Health Score Components (Weighted)

| Factor | Weight | Signal | Scoring |
|--------|--------|--------|---------|
| **Active Workflow Count** | 20% | # of workflows running ≥1x/week | 0 = none, 5 = active |
| **Seat Utilization Rate** | 20% | % of purchased seats with weekly logins | <30% = red, 60-89% = yellow, ≥90% = green |
| **Login Frequency (7-day window)** | 15% | Daily/weekly active users vs. total seats | Declining trend = red flag |
| **Support Ticket Volume** | 15% | # of unresolved tickets in last 30 days | >5 open = high friction |
| **Feature Adoption Breadth** | 15% | % of core features used (workflows, approvals, integrations) | <3 features = shallow adoption |
| **Net Promoter Score (NPS)** | 15% | Survey-based sentiment | ≤6 red / 7-8 yellow / ≥9 green |

### Health Score Tiers & Actions

| Tier | Score Range | Action Required | Response Timeline |
|------|-------------|-----------------|-------------------|
| **🟢 Healthy** | 80–100 | Standard engagement — quarterly business reviews, upsell opportunities in next renewal window | Proactive outreach every 90 days |
| **🟡 At Risk** | 50–79 | CS check-in call scheduled. Identify specific blockers. Offer training session or workflow audit. | Within 3 business days of tier drop |
| **🔴 Critical** | <50 | Immediate intervention: dedicated CS agent assigned, executive sponsor notification (for Enterprise), churn prevention protocol triggered | Same day |

### Quarterly Health Reviews (Enterprise Accounts)

1. Review usage trends and expansion opportunities
2. Align Tourbillon roadmap with customer priorities
3. Discuss multi-year licensing or seat increases
4. Identify additional use cases for cross-department adoption

---

## ⚠️ Escalation Procedures

### When to Escalate

| Trigger | Level 1 Response | Level 2 Escalation | Level 3 Escalation |
|---------|-----------------|--------------------|--------------------|
| User submits bug report → unresolved in 48h | CS Agent documents issue + tags Engineering Lead via Slack webhook (per SLA doc) | Product Manager triages within 24h; assigns sprint if confirmed bug | CTO notified if >10% of user base affected or security-related |
| Customer threatens to churn | CS Lead schedules retention call with customer and Account Executive | VP of Revenue involved if Enterprise contract at risk | CEO direct engagement for strategic accounts ($50k+ ARR) |
| Data loss / Security incident | Immediate CTO on-call escalation (per SLA doc Section "Escalation Path Step 5") | Legal + PR involvement for external comms | Board notification per governance procedures |
| Customer requests unsupported feature → frustration builds | CS documents as product feedback; logs in community forum (TOUR-61) | PM evaluates feasibility within next planning cycle; provides customer with roadmap visibility | — |

### Internal Escalation Slack Channels

| Channel | Purpose | Notify |
|---------|---------|--------|
| `#cs-critical` | Churn risk, data issues, security events | CS Lead + CTO on-call |
| `#cs-expansion` | Upsell/cross-sell opportunities, new use cases found | CS Lead + Sales Lead |
| `#cs-feedback` | Feature requests and product gaps from customers | CS Lead + Product Manager |

---

## 📈 Renewal & Expansion Strategies

### Pro Plan (Monthly/Annual) — Self-Serve Renewal with Intervention Triggers

**Standard Process:**
- Automated renewal email sent 30, 14, and 7 days before expiry
- In-app renewal banner visible in workspace for 60 days prior to expiration
- If payment fails: 2 grace period emails (Day 3 and Day 7 after failure) → account goes read-only

**Intervention Triggers:**
- User hasn't logged in for ≥14 days before renewal → proactive CS email with "We miss you" offer
- Health score dropped below 50 in last 60 days → CS call to understand friction
- Seat utilization <30% → propose seat reduction or suggest upgrading to higher tier (expansion)

### Enterprise Plan — Managed Renewal Process

**Renewal Timeline:**
| Milestone | Timing Before Expiry | Action |
|-----------|---------------------|--------|
| Initial renewal discussion | 120 days | CSM schedules review call; shares usage report and ROI summary |
| Expansion opportunity assessment | 90 days | Joint CS + Sales session identifying growth use cases, new teams/departments |
| Contract negotiation kickoff | 60 days | Legal drafts amended contract; pricing reviewed with finance |
| Executive alignment meeting | 30 days | VP-level call with customer decision-maker to finalize terms and expansion scope |
| Final confirmation & execution | 14 days | Signed contract received → CSM onboards expanded scope or new teams |

### Expansion Playbook (Upgrades & Cross-Sells)

**Identifying Expansion Signals:**
1. **Seat utilization >85% for 30+ consecutive days** → "You're running full — should we add more seats?"
2. **Workflow count exceeding plan limits** → "Upgrade to Enterprise for unlimited workflows + dedicated support"
3. **Multiple teams/ departments using Tourbillon independently** → "Cross-department licensing discount available"
4. **Frequent requests for advanced features (SSO, RBAC, private cloud)** → "Enterprise plan unlocks these — let's schedule a call"

**Expansion Offer Framework:**
- Always lead with value: highlight what they're *missing*, not just what costs more
- Offer bundled discounts for multi-year commitments (15% annual, 20% biennial)
- Provide ROI calculator showing cost savings vs. manual workflows

---

## 🛡️ Churn Prevention Playbook

### Red Flags Checklist

| Signal | Severity | Action |
|--------|----------|--------|
| Login activity drops ≥60% in 14-day window | High | CS check-in within 24h |
| Support ticket volume spikes ≥3x normal | Critical | Immediate triage — identify root cause |
| Negative NPS survey response (≤6) | High | CS call scheduled; executive note from CTO if Enterprise |
| Competitor mentions in feedback or calls | Medium-High | Competitive analysis review + tailored value prop outreach |
| Payment failure + no login for 7 days after | Critical | Account at risk → "Win-back" email sequence triggered |

### Win-Back Email Sequence (Payment Failure)

**Email 1 — Day 3 post-failure:**  
*Subject: Your Tourbillon workspace is on pause — let's fix your payment.*  
Soft nudge with updated billing link. Emphasize data safety and easy reactivation.

**Email 2 — Day 7 post-failure:**  
*Subject: Quick question — did Tourbillon not meet your needs?*  
Asks for honest feedback; offers discount for return or cancellation survey.

**Email 3 — Day 14 post-failure (final):**  
*Subject: Your workspace data is safely stored — but expires in 7 days.*  
Last-chance notification with clear deactivation timeline. Includes CSM contact info for retention appeal.

---

## 📊 Metrics & KPI Dashboard

### Customer Success Dashboard (Built into Admin Panel)

| Report | Frequency | Audience |
|--------|-----------|----------|
| Health Score Summary (All Accounts) | Weekly | CS Team + Leadership |
| Renewal Forecast (Next 90 Days) | Monthly | Sales + CS Lead + CEO |
| Expansion Pipeline Value | Bi-weekly | Sales + CS |
| Churn Risk Report (Top 10 at-risk accounts) | Weekly | CS Lead + VP Revenue |
| NPS Trend Analysis | Monthly | Product + CS + Marketing |

### Annual Review — Customer Success Year-End Report

1. **Retention Rate** vs. target
2. **Revenue Retention (NRR/GRR)** breakdown by plan tier
3. **Expansion revenue** total and as % of overall ARR
4. **Top churn reasons** analysis with product feedback mapping
5. **Customer success team ROI** — CAC payback period, LTV improvement

---

## 📝 Implementation Notes for Devs & Ops

1. **Health Score Engine:** Requires data pipeline to aggregate usage signals (logins, workflow runs, feature adoption). Coordinate with Engineering for dashboard integration.
2. **Automated Email Triggers:** Wire into marketing automation platform; align messaging tone with brand voice guidelines (`marketing/marketing-overview.md`).
3. **CSM Assignment Logic:** Auto-assign CSM to Enterprise accounts; assign CS Agent to Pro teams based on queue capacity. Define SLA-based routing rules.
4. **Renewal Calendar Integration:** Sync renewal dates into shared team calendar + trigger automated reminders at defined milestones above.

---

*Drafted by PM Harness on 2026-06-26. Aligned with TOUR-85 (User Onboarding Flow) and support SLA document (`marketing/support-sla.md`). Health score framework pending engineering input for data pipeline feasibility.*
