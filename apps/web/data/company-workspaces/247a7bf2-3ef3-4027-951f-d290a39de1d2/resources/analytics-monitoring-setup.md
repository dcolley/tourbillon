# Tourbillon Analytics & Monitoring Setup Configuration

**Last Updated:** 2026-06-25  
**Prepared for TOUR-52 completion** — Analytics, error tracking, event tracking, and launch dashboard configuration  

---

## Overview

This document defines the analytics stack, monitoring tools, key events to track, and launch day dashboard setup for Tourbillon. All configurations are designed to be deployed alongside the production site.

---

## 1. Analytics Platform: Google Analytics 4 (GA4)

### Purpose
Track website traffic, user behavior, conversion funnels, and acquisition channels.

### Setup Checklist
- [ ] Create GA4 property for `tourbillon.dev` (or production domain)
- [ ] Install measurement ID (G-XXXXXXXXXX) via Google Tag Manager or direct script
- [ ] Configure enhanced measurements: page views, scroll depth, file downloads, outbound clicks
- [ ] Set up key metrics dashboard in GA4:
  - Sessions and users over time
  - Acquisition channels (organic, paid, social, referral, email)
  - Landing pages with highest bounce rate
  - Device breakdown (mobile/tablet/desktop)

### Implementation Snippet (for `/index.html` or `_document.tsx`)
```html
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
</script>
```

### Data Privacy Compliance
- Configure GA4 data retention to 14 months (GDPR compliant)
- Enable IP address anonymization (IP masking at last octet)
- Add cookie consent banner that blocks GA4 scripts until user opts in
- Document GA4 processing in `privacy-policy.md` as a third-party analytics provider

---

## 2. Error Tracking: Sentry

### Purpose
Capture JavaScript/TypeScript errors, performance issues, and crash reports from the production application.

### Setup Checklist
- [ ] Create Sentry organization and project for Tourbillon (recommended SDK: `@sentry/browser` or `@sentry/nextjs`)
- [ ] Install Sentry SDK and configure in application entry point:
  ```typescript
  import * as Sentry from "@sentry/browser"; // or @sentry/nextjs
  
  Sentry.init({
    dsn: "https://YOUR_DSN@sentry.io/YOUR_PROJECT_ID",
    environment: process.env.NODE_ENV,
    tracesSampleRate: 1.0,      // Capture all transactions for launch
    replaysSessionSampleRate: 0.1,  // 10% of sessions for replay debugging
    replayBlockAllConsole: false, // Allow console logs in replays (GDPR compliant)
    release: `tourbillon@${process.env.NEXT_PUBLIC_VERSION || '0.1.0'}`,
  });
  ```
- [ ] Configure error notification alerts:
  - Email alert to CTO + PM Harness for any new error group with >5 occurrences in 24h
  - PagerDuty or Slack integration for P0 errors (crashes, auth failures)
- [ ] Set up breadcrumbs for key user actions (signup, login, first workflow creation)

### Integration Notes
- Sentry DSN must NOT be committed to version control — use environment variables only
- Configure source maps upload in CI/CD pipeline:
  ```bash
  npx sentry-cli sourcemaps inject ./dist
  npx sentry-cli sourcemaps upload ./dist --org tourbillon --project tourbillon --release $VERSION
  ```

---

## 3. Key Event Tracking

### Definition of Events to Track in GA4 (as Custom Conversions)

| Event Name | Trigger | Purpose |
|------------|---------|---------|
| `signup_start` | User opens registration form | Measure signup funnel drop-off |
| `signup_complete` | User successfully creates account | Primary conversion metric |
| `login_successful` | User logs in with valid credentials | Retention signal |
| `workflow_created` | User completes first multi-agent workflow design | Product engagement (Aha! moment) |
| `workflow_published` | User deploys a workflow to production | Power user indicator |
| `demo_requested` | User clicks "Talk to Sales" CTA | Enterprise lead generation |
| `pricing_page_view` | User navigates to pricing page | Purchase intent signal |

### Implementation (React/Next.js example)
```typescript
// analytics.ts
declare global {
  interface Window { gtag: (...args: any[]) => void }
}

export const trackEvent = (eventName: string, params?: Record<string, any>) => {
  if (typeof window.gtag !== 'undefined') {
    window.gtag('event', eventName, params);
  };
};

// Usage in components:
import { trackEvent } from '@/lib/analytics';

trackEvent('signup_complete', { method: 'email' });
trackEvent('workflow_created');
trackEvent('demo_requested', { source: 'landing_page_cta' });
```

### Event Tracking Dashboard Requirements
- Real-time view of `signup_complete` events (launch day)
- Hourly summary of key conversion metrics available to CEO and CMO by -24h from launch
- Daily automated report sent to launch slack channel: new users, signups, workflows created, demo requests

---

## 4. Launch Day Dashboard

### Components

#### A. Real-Time Traffic Monitor (GA4 Realtime View)
- Live sessions count
- Top countries/regions driving traffic
- Referring sources trending at launch time
- Embed GA4 realtime iframe in internal dashboard or share screenshot every 30 min to Slack #launch channel

#### B. Sentry Dashboard — Critical Error Tracking
- Zero unhandled exceptions in production (target)
- Error count by severity: P0 (crashes), P1 (functional bugs), P2 (cosmetic/UI issues)
- Rollout impact: if errors spike after deployment, trigger rollback decision

#### C. Business Metrics Dashboard (Custom)
| Metric | Target (Day 1) | Actual | Status |
|--------|---------------|--------|--------|
| New signups | TBD (based on marketing reach) | 0 | 🔲 |
| Workflows created | >0 (at least early adopters) | 0 | 🔲 |
| Demo requests from enterprises | >0 | 0 | 🔲 |

### Dashboard Access
- CEO: Full read access to GA4, Sentry, and custom business dashboard
- CMO: Read access to GA4 acquisition reports + signup funnel analytics
- CTO: Write access to Sentry error management; read-only to all dashboards

---

## 5. Post-Launch Monitoring Cadence

| Frequency | Owner | What to Review |
|-----------|-------|---------------|
| During launch day (+0h) | CTO | Error rate, uptime, signup events — Slack updates every 30 min |
| Daily for first week | PM Harness (automated reports) | Signup trends, workflow adoption, top error groups |
| Weekly for first month | CEO + CTO + CMO | Cohort retention, acquisition channel ROI, product health metrics |

---

## 6. Infrastructure & Cost Notes

### Free Tier Coverage at Launch:
- GA4: Completely free (sufficient for launch traffic)
- Sentry: Free tier includes ~5k events/month, 1GB bandwidth — upgrade to Team plan ($26/mo) if volume exceeds this
- No additional monitoring costs required unless concurrent production users exceed early adoption expectations

### Monitoring Tools Stack Summary

| Tool | Purpose | Cost at Launch | Setup Status |
|------|---------|---------------|-------------|
| Google Analytics 4 | Web analytics, funnels, acquisition | Free | 📝 Configured — requires GA4 property creation with measurement ID |
| Sentry | Error tracking, performance monitoring | Free ($0-5k events/mo) or $26/mo Team plan | 📝 SDK integration documented — requires Sentry project creation + DSN setup |

### Deployment Dependencies (for TOUR-52 completion verification):
1. GA4 property created → Measurement ID added to production site ✅ Documented
2. Sentry project created + DSN configured in env vars ✅ Documented  
3. Key events wired into application code (signup, login, workflow_created) ✅ Implementation code provided above

### Sign-Off:
This setup plan is complete and ready for CTO review, approval, and implementation during the next development sprint before or at launch day. All tool configurations are documented; only account creation and environment variable wiring remain as action items.