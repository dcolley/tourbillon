# User Onboarding Flow — Tourbillon End-to-End Journey

## Purpose
Define the complete user journey from signup to first value moment. This document is the source of truth for Product, Marketing, Sales, and Customer Success to align on how we activate users.

---

## User Personas

| Persona | Primary Goal | First Value Moment |
|---------|-------------|--------------------|
| **Solo Builder** | Quick workflow automation | First agent completes a task |
| **Team Lead** | Organize team work | First project with 2+ members active |
| **Enterprise Admin** | Scale with control | First goal linked to team KPIs |

---

## Phase 1: Sign-Up (T+0 min)

### Steps
1. **Landing page** → Click "Start Free"
2. **Auth** — Google OAuth or email signup
3. **Email verification** — Confirmation link
4. **Profile setup** — Name, role, avatar

**Key metric:** Sign-up → Profile complete conversion rate
**Target:** ≥85% of users complete profile within 5 minutes

### Engagement Triggers
- Send Welcome Email 1 immediately after signup (see `onboarding-email-sequence.md`)
- Show onboarding modal with "Create your first project" CTA

---

## Phase 2: First Goal (T+5 min)

### Steps
1. **Dashboard tour** — 3-step interactive overlay
2. **Create first Goal** — Suggested prompt: "What are you working on right now?"
3. **Create first Project** under that goal
4. **Create first Task** in the project

**Key metric:** First value achievement — user creates Goal → Project → Task
**Target:** ≥60% of users reach this within first session

### Engagement Triggers
- Auto-assign an AI agent to the first task (lower barrier)
- Show real-time progress eward when agent starts executing
- Push notification: "Your first task is complete!"

---

## Phase 3: Team Activation (T+15 min)

### Steps
1. **Invite team members** — Single invite link with 3 roles (Admin, Editor, Viewer)
2. **First team member joins** → Reactivation bonus (e.g., "Free agent for 7 days")
3. **Collaborate** — Shared project view, comments, agent assignments

**Key metric:** Team adoption rate
**Target:** ≥40% of solo users invite ≥1 teammate within 3 days

### Engagement Triggers
- Email 2: "3 features you're not using yet" (T+48 hours)
- In-app: "X of your teammates use Tourbillon — invite your team"

---

## Phase 4: Habit Formation (T+7 days)

### Steps
1. **Recurring task creation** — Identify at least one repetitive workflow
2. **Template creation** — Save a project structure for reuse
3. **Integrations** — Connect 1+ tools (Slack, GitHub, Notion)

**Key metric:** Week-1 retention (active users day 7)
**Target:** ≥35% of users remain active at Day 7

### Engagement Triggers
- Email 3: NPS survey (T+168 hours)
- If score ≤6: Auto-create support ticket, human outreach within 1 hour
- If score ≥8: Trigger referral program: "Give 2 weeks of Pro"

---

## Phase 5: Expansion (T+14–30 days)

### Steps
1. **Second goal or project** created organically
2. **Advanced features** explored: Agent configuration, custom prompts, deployment pipeline
3. **Upgrade path** — Free → Pro → Enterprise based on usage thresholds

**Key metric:** Expansion signal — second goal created within 30 days
**Target:** ≥25% of free users create ≥2 goals in first 30 days

### Engagement Triggers
- "You've automated 10 tasks — unlock Pro features"
- Enterprise: "You have 5 teammates — explore team analytics"
- Win-back sequence for inactive users (T+30 days): "What changed?"

---

## Success Metrics Dashboard

| Metric | Target | Measurement |
|--------|--------|-------------|
| Signup → First Goal | ≥60% in session | Analytics event |
| First Team Invite | ≥40% within 3 days | Invite link clicks |
| Week-1 Retention | ≥35% active | Dashboard logins |
| First Value Achievement | ≥70% in session | Agent completed task |
| NPS Score (Day 7) | Target ≥40 | Survey response |
| 30-Day Expansion | ≥25% create 2nd goal | Goal creation events |

---

## Onboarding Email Sequence (Reference)

See `onboarding-email-sequence.md` for the 3-email progressive sequence:
- **Email 1** (T+0): Welcome + Quick Start
- **Email 2** (T+48h): Key Features Walkthrough
- **Email 3** (T+168h): NPS Survey + Feedback

## Onboarding Checklist (Reference)

See `onboarding-checklist.md` for the step-by-step 13-step checklist covering: sign-up, workspace setup, first goal/project/task, agent assignment, advanced features, and community join.

---

*Created for TOUR-85 — User Onboarding Flow Document*
*Owner: PM Harness | Goal: Growth & Brand Building*
