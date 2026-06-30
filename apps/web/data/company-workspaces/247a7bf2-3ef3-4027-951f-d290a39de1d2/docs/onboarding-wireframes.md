# Onboarding Wireframe Spec — Tourbillon

## Flow: Signup → Activation → "Aha!" Moment

### 1. Signup Page
**Route:** `/signup`
**Layout:** Split screen (left: form, right: feature preview)

**Form Fields:**
- Email input (with real-time validation)
- Password or GitHub/Google OAuth (primary: GitHub)
- "Create Account" primary CTA
- Link: "Already have an account? Sign in"

**Right Panel:**
- Live dashboard preview with animated cards
- Key stats: "1M+ goals managed", "500+ weekly active teams"

---

### 2. First Goal Creation (Immediate Post-Signup)
**Route:** `/onboarding/create-goal`

**UI:**
- Modal overlay over dashboard: "Create Your First Goal"
- Step 1: Goal name input (placeholder: "Launch marketing campaign")
- Step 2: Add description (optional, collapsible)
- Step 3: Select owner (auto-selects: "Me" with dropdown)
- CTA: "Create Goal" → auto-creates Goal + Project + first Task

**Auto-created content:**
- Goal: User's first goal
- Project: "Getting Started" under this goal
- Task: "Complete your profile setup" under the project

---

### 3. Activation Dashboard (The "Aha!" Moment)
**Route:** `/dashboard` (post-first-goal)

**Key Sections:**
- **Progress Panel:** % completion for first goal, project, task
- **Quick Actions:** "Add Project", "Invite Teammate", "Connect Agent"
- **Notification Bar:** "Your agent is ready! Try assigning your first task"
- **Milestone Tracker:**
  - [x] Created your first goal
  - [ ] Invite a teammate
  - [ ] Connect an AI agent
  - [ ] Complete your first task

---

### 4. Welcome Tooltip Sequence (Intercom-style)
**Trigger:** First dashboard load

**Tooltips (progressive):**
1. **Goal Panel:** "Set your team's north star — create a goal"
2. **Project Column:** "Break goals into actionable projects"
3. **Task List:** "Tasks drive execution — create one now"
4. **Agent Badge:** "Assign AI agents to automate tasks"

**Dismissal:** "Got it" / "Tourbillon Tourbillon Team" buttons

---

## Activation KPIs

| KPI | Target | Measurement |
|-----|--------|------------|
| Day-1 Logins | ≥60% of signups | `analytics-monitoring-setup.md` |
| Day-7 Sessions | ≥4 sessions/user | Google Analytics + custom `/{tracking-config.md` |
| Day-30 Features | ≥3 features used | User `user-journey-map.md` |

---

## Wireframe Assets

| Asset | Format | Location |
|---|---|---|
| Signup Page | Figma | `design/signup-page.figma` |
| First Goal Modal | Figma | `design/first-goal-modal.figma` |
| Onboarding Dashboard | Figma | `design/onboarding-dashboard.figma` |
| Tooltip Sequence | Lottie | `design/tooltips.lottie` |
