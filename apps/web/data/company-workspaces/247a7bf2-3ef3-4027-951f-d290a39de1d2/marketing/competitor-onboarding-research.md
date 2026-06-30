# Competitor Onboarding Research — Best Practices

## Purpose
Analyze onboarding flows of Intercom, Linear, and Notion to identify patterns that can improve Tourbillon's user activation.

## Methodology
Qualitative analysis based on shared workspace docs and competitor public flows.

## Intercom

**Onboarding flow:**
- Product Tour widget — Drive user attention to key areas using in-app modals
- Spotlight modals — Clean, step-by-step tooltips with progressive disclosure
- Welcome message with auto-show delays
- Milestone tracking (completing profile, first goal, etc.)

**Strengths:**
- Strong product tours (Drive) to highlight key features
- Welcome message with progressive delays
- Clean, step-by-step tooltip flows

**Weaknesses:**
- Email sequences lack personalization by user persona
- NPS survey lacks actionable insights

**Key Takeaways:**
- Use in-app tooltips for progressive feature discovery
- Track milestones with gamification (e.g., "X of your teammates use Tourbillon")
- Auto-create support tickets when NPS ≤ 6

## Linear

**Onboarding flow:**
1. **Project hub** → First value moment: "Create First Project"
2. **Database-driven projects** — Goal → Project → Task hierarchy
3. **Drag-and-drop UI** for task management
4. **GitHub OAuth integration**
5. **Email sequence** with clear first-value moment
6. **Referral program**: "Give 2 weeks of Pro"
7. **Real-time notifications**: "Your first task is complete!"

**Strengths:**
- Excellent use of GitHub as primary auth option
- Real-time notifications for immediate feedback
- Referral program ("Give 2 weeks of Pro")
- Win-back email for inactive users

**Weaknesses:**
- Team activation relies weekly (3 days to invite team
- Requires ≥40% of solo users invite team within 3 days
- Higher team activation relies on email-based invite links

**Key Takeaways:**
- Auto-assign an agent to lower barrier to entry
- Progress rewards when agent starts executing
- Target first value moment by creating Goal → Project → Task

## Notion

**Onboarding flow:**
1. **Template hub** → Dupe project templates to get started
2. **Database-driven projects** — Goal → Project → Task hierarchy
3. **Drag-and-drop UI** for task management

**Strengths:**
- Template-first approach lets users start with pre-built project structures
- Database-driven approach for goal → project → task
- Drag-and-drop UI for organization

**Weaknesses:**
- Can be overwhelming for first-time users
- No clear first-value moment

**Key Takeaways:**
- Template-first approach to get users started
- Use database-driven approach for goal → project → task
- Link users to goals to team KPIs

## Best Practices Summary

| Practice | Source | Implementation Note |
|---------------------------|----------
| Email onboarding email sequences that drive first-value | Intercom | Auto-send when user ratio increases task
| Real-time notifications for user feedback | Linear | When agent starts executing a task
| Template-first approach to get users started | Notion | Provide pre-built project structures
| Team activation via invite link | Linear | Auto-assign agent to lower barrier
| Progress tracking via gamification | Intercom | "X of your teammates use Tourbillon"

## Recommendations for Tourbillon

1. **Add in-app tooltips** for progressive feature discovery
2. **Implement GitHub OAuth** as primary auth option
3. **Create template hub** for project templates
4. **Auto-assign AI agents** to first value moment
5. **Track milestones** with gamification to drive team activation
6. **NPS survey** when NPS ≤ 6: auto-create support ticket

## Gaps in Our Current Flow

| Gap | Current State | Recommended Fix |
|-----|---------------|-----------------|
| In-app tooltips | Dashboard overlay (basic) | Progressive, step-by-step tooltips (Intercom-style) |
| Real-time feedback | Email 2 (T+48h) | In-app notifications when agent starts |
| Template hub | None | Pre-built project structures (Notion-style) |
| User persona tracking by user | None | Track first value moment, template-first approach |

## References

- Internal: `marketing/onboarding-flow.md`
- Internal: `marketing/onboarding-email-sequence.md`
- Internal: `marketing/onboarding-checklist.md`
