# Feedback Routing Configuration (TOUR-62)

## Overview
This document configures the automated feedback routing system for Tourbillon. 
Routes are defined by keyword matching and send to Slack channels or email.

## Environment Variables Required

```env
# Slack Integration
SLACK_WEBHOOK_URL=<your-slack-incoming-webhook-url>

# Email (optional — fallback when Slack is unavailable)  
SMTP_HOST=smtp.tourbillon.com
SMTP_PORT=587
SMTP_USER=noreply@tourbillon.com
SMTP_PASSWORD=<encrypted>
```

## Routing Rules

| Keywords | Channel(s) | Priority |
|----------|-----------|----------|
| bug, error, crash, broken, not working, failed, exception | #critical-issues + #product-feedback | High |
| feature request, suggestion, would be nice, could add, wish | #product-feedback | Medium |
| pricing, billing, cost, subscription, cancel, refund | #customer-support | High |
| complaint, frustrated, disappointed, terrible, awful, worst | #customer-support + #product-feedback | Critical |
| *(none matched)* | #general-feedback | Medium |

## Slack Channel Setup

1. Create the following channels in your Slack workspace if they don't exist:
   - `#critical-issues` — For urgent bug reports and crashes
   - `#product-feedback` — For feature requests and general product feedback
   - `#customer-support` — For billing, pricing, and customer complaints  
   - `#general-feedback` — Catch-all for uncategorized feedback

2. Generate a Slack Incoming Webhook URL:
   - Go to https://api.slack.com/apps → Create New App
   - Add "Incoming Webhooks" feature
   - Copy the webhook URL to your `.env.production` as `SLACK_WEBHOOK_URL`

## Testing

```bash
# Test with curl (replace SLACK_WEBHOOK_URL in .env first)
curl -X POST http://localhost:3000/api/feedback \
  -H "Content-Type: application/json" \
  -d '{
    "type": "bug_report",
    "subject": "Login page is broken", 
    "message": "Getting a 500 error when trying to login with Google",
    "email": "test@example.com"
  }'

# Expected: Feedback routed to #critical-issues and #product-feedback Slack channels
```

## KPIs to Monitor (from SLA document)

| Metric | Target |
|--------|--------|
| Automated resolution rate (Tier 1) | >60% of all feedback |
| First response time (Tier 3) | <1 hour during business hours |
| Escalation rate (Tiers 2→3) | <20% of Tier 2 tickets |
