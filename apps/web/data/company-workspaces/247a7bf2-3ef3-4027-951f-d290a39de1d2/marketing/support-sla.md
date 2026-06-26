# Tourbillon Support SLA Document

## Overview
This document defines the support tier structure, response time targets, and escalation paths for customer interactions post-launch.

---

## Tier 1: Automated (Response within 5 min)
- Self-service bot via FAQ and troubleshooting flows
- Auto-categorization of incoming feedback by keywords (bug, feature request, billing, etc.)
- Initial triage routing to correct channel (#product-feedback, #critical-issues, etc.)
- Status page integration for outage notifications
- Implementation: TOUR-62 automated webhook system

## Tier 2: Community/Documentation (Response within 2 hours)
- Knowledge base article suggestions based on search queries
- Community forum responses from power users
- Documentation improvements triggered by common question patterns
- Target: <10% of all tickets should reach this tier
- Team: Product Docs + Community Manager

## Tier 3: Human Agent (Response within 4 hours for business day, next-day for after-hours)
- Direct customer support interaction via email or in-app chat
- Bug verification and reproduction with user environment details
- Feature request handling with product team visibility
- Escalation path to Engineering Lead if technical issue confirmed

---

## Escalation Path

| Step | Trigger | Action | Response Target |
|------|---------|--------|-----------------|
| 1 | User submits feedback | Automated system catches & categorizes | <5 min |
| 2 | Not resolved in 30 min (Tier 1) | Escalate to community/docs (Tier 2) | <2 hours |
| 3 | Unresolved or marked "critical" | Human agent assignment (Tier 3) | <4 hours |
| 4 | System issue >5% of users affected | Immediate Engineering Lead notification | <1 hour |
| 5 | Data loss, security breach, or legal issue | CTO on-call escalation | Immediate |

---

## Metrics & KPIs

| Metric | Target | Measurement Frequency |
|--------|--------|----------------------|
| First response time (Tier 3) | <1 hour during business hours | Daily |
| Resolution rate within SLA | >90% of all tickets | Weekly |
| CSAT score post-support | >4.2/5 | Per interaction |
| Automated resolution rate (Tier 1) | >60% of all feedback | Weekly |
| Escalation rate (Tiers 2→3) | <20% of Tier 2 tickets | Monthly |

---

## SLA Exceptions
- **Holiday/After-hours:** Response targets extend to next business day for non-critical issues
- **Outage Events:** All agents shift to crisis mode; response target drops to <15 min for any outage-related ticket
- **New Feature Launch Week (first 72h):** Human agent coverage increases by 50% during launch week

---

## Implementation Notes
- SLA monitoring dashboard should be built into the admin panel (see TOUR-61 NPS integration)
- Slack webhook alerts for any ticket that breaches Tier 1 automated threshold after 30 min
- Weekly SLA report generated every Monday morning and shared with leadership team
