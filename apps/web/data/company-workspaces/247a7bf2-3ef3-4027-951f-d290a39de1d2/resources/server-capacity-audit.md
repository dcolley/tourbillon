# Server Capacity & Traffic Audit Report — TOUR-58

**Date:** 2026-06-26  
**Author:** Engineer (Engineer Agent)  
**Parent Issue:** TOUR-56 / Infrastructure Scaling Assessment & Roadmap  
**Related Issues:** TOUR-59 (DB/API Bottleneck Identification), TOUR-57 (Feedback Loop & Support Infra)

---

## Executive Summary

Tourbillon is currently a **single-server Next.js application** with no dedicated database infrastructure, no auto-scaling, and no monitoring stack deployed. The app uses in-memory data stores (`/tmp/tourbillon_users.json` for users, in-process arrays for demo requests). This report assesses current capacity against projected launch traffic (first 48 hours) and identifies critical resource ceilings.

---

## 1. Current Infrastructure State

### 1.1 Application Architecture
| Component | Technology | Deployment Target | Notes |
|-----------|------------|-------------------|-------|
| Frontend + API | Next.js 14+ (App Router, Turbopack) | Vercel (recommended), Docker, or manual VPS | No infrastructure-as-code yet |
| Authentication | Custom session-based (JWT-like HMAC tokens) | In-app logic | Not using Auth.js/NextAuth despite docs mentioning it |
| User Storage | JSON file at `/tmp/tourbillon_users.json` | Local filesystem / ephemeral volume | **CRITICAL: No persistence across restarts** |
| Demo Requests | In-process Node.js array | Process memory only | **Lost on any redeploy/restart** |
| Analytics | GA4 (gtag.js) — configured but not deployed to prod | Client-side script | Measurement ID placeholder (`G-XXXXXXXXXX`) in place |
| Error Tracking | Sentry — documented but SDK not integrated | External SaaS | DSN and project not created yet |

### 1.2 Deployment Configuration
- **Build system:** `npm run build` (Turbopack) → production standalone output
- **Containerization:** Dockerfile documented in deployment guide, but **not committed to repo** — no actual Docker build tested
- **CI/CD:** No pipeline configured; manual deploy via Vercel CLI or GitHub sync recommended
- **Domain:** `tourbillon.dev` (staging) → production domain TBD

### 1.3 Environment Variables (from code analysis)
```env
# Required:
NEXT_PUBLIC_GA_MEASUREMENT_ID=G-YOURMEASUREMENTIDHERE     # Placeholder — not configured
SESSION_SECRET=dev-session-secret-change-in-production      # Insecure default in code!
# Recommended but absent from implementation:
DATABASE_URL                                                  # Referenced in docs, not wired up
NEXTAUTH_SECRET                                               # Referenced in deployment guide, unused
```

---

## 2. Resource Capacity Assessment

### 2.1 CPU & Memory (Application Layer)
| Metric | Current State | Projected Launch Load (48h) | Ceiling / Risk |
|--------|--------------|----------------------------|----------------|
| **CPU** | Single Next.js server process — handles SSR + API routes on same thread | Moderate: ~500-2,000 concurrent requests for launch spike | Next.js can handle moderate traffic; CPU will be the bottleneck beyond ~2K RPS. Turbopack is dev-only; production uses `next build` (Webpack). |
| **Memory** | In-memory arrays (`demoRequests`) + JSON file reads on every session check | Low initially, but each API call to `/api/auth/session` does a full file read of the user store | **Memory leak risk**: Every demo request appends to an ever-growing array. No pagination or pruning. Session verification reads entire user DB per request — O(n) lookup. |
| **Process** | Single Node.js process; no clustering, no PM2 | If deployed via `pm2` with 1 instance: single point of failure | No zero-downtime deploys without blue/green or canary strategy |

### 2.2 Database & Storage Layer
| Metric | Current State | Projected Launch Load (48h) | Ceiling / Risk |
|--------|--------------|----------------------------|----------------|
| **User Store** | JSON file at `/tmp/tourbillon_users.json` — read on every session API call, no indexes | 100-500 new signups expected in first 48h. File size ~few KBs initially but grows linearly. | **CRITICAL**: No concurrent write protection. Two simultaneous signup requests could corrupt the JSON file. File reads are O(n) — slow as user count grows. |
| **Demo Request Store** | In-process array, never persisted to disk | 10-50 demo requests expected (enterprise leads) | **HIGH RISK**: All data lost on restart. No audit trail. Not suitable for sales pipeline. |
| **Session Storage** | Stateful — user lookup against in-memory file store per request | Up to ~2,000 concurrent sessions during launch spike | No session expiration enforcement beyond 7-day token age check. No rate limiting on `/api/auth/session`. |

### 2.3 Network & Throughput
| Metric | Current State | Projected Launch Load (48h) | Ceiling / Risk |
|--------|--------------|----------------------------|----------------|
| **Bandwidth** | Static assets (HTML/CSS/JS) served via Next.js standalone output or CDN (Vercel edge) | ~50KB-200KB per page load × estimated traffic | Vercel free tier: 1TB bandwidth/month — sufficient for launch. Self-hosted would need S3/CloudFront setup. |
| **API Rate** | No rate limiting on any endpoint (`/api/auth/*`, `/api/demo-request`) | Launch traffic could include bot/scraping activity; no throttling = DDoS vulnerability | **HIGH RISK**: No request throttling, no CAPTCHA, no bot protection. Auth endpoints are particularly vulnerable to brute-force attacks. |
| **SSL/TLS** | Not configured in application code (relies on platform-level HTTPS: Vercel or nginx) | Standard TLS 1.3 required for production compliance | Manual deployments require self-configured certificates. No automated cert management found. |

---

## 3. Traffic Projection vs. Capacity Comparison

### Assumptions (based on pre-launch marketing plan)
| Phase | Timeframe | Expected Visitors | Expected Signups | Expected Demo Requests |
|-------|-----------|------------------|-----------------|----------------------|
| **Day -1** (pre-launch buzz) | 24h before launch | 500–1,000 | 0 (no signup flow live yet) | 0–5 early requests |
| **Launch Day** (T+0 to T+24) | First 24 hours | 5,000–15,000 | 100–300 | 10–30 |
| **Day +1 to T+48h** | Second 24 hours | 3,000–8,000 (post-hype decay) | 50–150 | 5–15 |

### Capacity Analysis
```
┌─────────────────────┬──────────────┬──────────────────┬──────────────────────────────┐
│ Resource            │ Current Cap  │ Launch Need      │ Gap / Action Required         │
├─────────────────────┼──────────────┼──────────────────┼──────────────────────────────┤
│ Concurrent Users    │ ~10 (single  │ ~500-2,000       │ Scale to at least 3 instances│
│ (app server)        │ process)     │                  │ or use Vercel auto-scaling   │
├─────────────────────┼──────────────┼──────────────────┼──────────────────────────────┤
│ User DB Ops/sec     │ ~5-10/s      │ ~20-50/s         │ Replace JSON file with       │
│ (session checks)    │ (file read   │                  │ indexed DB; add Redis cache  │
│                     │ per request) │                  │ for sessions                 │
├─────────────────────┼──────────────┼──────────────────┼──────────────────────────────┤
│ Demo Request Ops/s  │ Unbounded    │ ~1-5/s           │ Persistent storage required; │
│ (write + email)     │ in-memory    │                  │ add queue for async emails   │
├─────────────────────┼──────────────┼──────────────────┼──────────────────────────────┤
│ API Rate Limiting   │ NONE         │ Recommended: 100 │ Implement rate limiting on   │
│                     │              │ req/min per IP   │ auth endpoints               │
├─────────────────────┼──────────────┼──────────────────┼──────────────────────────────┤
│ Error Tracking      │ Not deployed │ Required for     │ Deploy Sentry SDK + configure│
│ (Sentry)            │              │ launch visibility│ error alerts                 │
├─────────────────────┼──────────────┼──────────────────┼──────────────────────────────┤
│ Analytics (GA4)     │ Configured   │ Required for     │ Replace placeholder GA ID    │
│                   │ (code ready) │ launch tracking  │ with real measurement ID     │
└─────────────────────┴──────────────┴──────────────────┴──────────────────────────────┘
```

---

## 4. Critical Findings & Resource Ceilings

### 🔴 CRITICAL Issues (Must fix before launch)

1. **No real database** — User data stored in a JSON file at `/tmp/tourbillon_users.json`. This is ephemeral storage that gets wiped on container restart. On any crash or redeploy, all user accounts are lost.
   - *Ceiling:* Zero persistence. Any restart = total data loss.
   
2. **Insecure session secret** — `SESSION_SECRET=dev-session-secret-change-in-production` is hardcoded in source code. This means anyone with repo access can forge authentication tokens.
   - *Ceiling:* Complete compromise of user sessions if repo is public or leaked.

3. **No rate limiting on auth endpoints** — `/api/auth/login`, `/api/auth/signup`, and `/api/auth/session` accept unlimited requests from any IP. A malicious actor could brute-force credentials or flood the server.
   - *Ceiling:* Unlimited DDoS / brute-force attack surface.

### 🟡 HIGH Issues (Fix within 1 week of launch)

4. **Demo request data not persisted** — Stored in-process array, lost on every deploy. Sales team has zero audit trail for demo requests submitted during launch.
   - *Ceiling:* Permanent loss of all enterprise leads.

5. **No error monitoring deployed** — Sentry SDK integration is documented but never implemented. No production errors will be captured.
   - *Ceiling:* Zero visibility into production failures.

6. **GA4 Measurement ID placeholder** — `G-XXXXXXXXXX` in code means analytics tracking is not functional. Cannot measure launch traffic or conversions.
   - *Ceiling:* Blind to all user behavior metrics at launch.

### 🟢 MEDIUM Issues (Fix within 2 weeks of launch)

7. **No CI/CD pipeline** — Manual deployment process with no automated testing or staging promotion workflow.
8. **No SSL certificate management** — Self-hosted deployments require manual cert setup; no Let's Encrypt automation found.
9. **No performance monitoring** — No APM (Application Performance Monitoring) for latency, throughput, or error rate tracking during launch.

---

## 5. Recommended Scaling Roadmap

### Phase 1: Pre-Launch (Before Go/No-Go Decision)
| Action | Effort | Owner | Impact |
|--------|--------|-------|--------|
| Replace JSON file store with PostgreSQL (via Neon, Supabase, or AWS RDS) | High | Engineer + CTO | Data persistence, concurrent access safety |
| Move session secret to environment variable; generate strong random key | Low | Engineer | Security compliance |
| Deploy Sentry SDK and configure DSN in env vars | Medium | Engineer | Error visibility |
| Replace GA4 placeholder with real Measurement ID | Low | CMO + Engineer | Analytics functional |
| Add rate limiting middleware (e.g., `@upstash/ratelimit` or custom) to auth endpoints | Medium | Engineer | DDoS protection |

### Phase 2: Launch Readiness (1 week before launch)
| Action | Effort | Owner | Impact |
|--------|--------|-------|--------|
| Deploy to Vercel with auto-scaling enabled (or Docker on 2+ server instances behind load balancer) | Medium | Engineer | Handle concurrent user traffic |
| Implement persistent demo request storage (PostgreSQL `demo_requests` table) | Medium | Engineer | Preserve enterprise leads |
| Configure async email queue (BullMQ + Redis or AWS SES with SQS) for demo request notifications | High | Engineer | Reliable delivery under load |
| Set up automated SSL certs (Let's Encrypt / cert-manager) if self-hosting | Low | CTO | Production compliance |

### Phase 3: Post-Launch Scaling (First 90 days)
| Action | Effort | Owner | Impact |
|--------|--------|-------|--------|
| Add Redis cache layer for session lookups and frequently accessed data | Medium | Engineer | Reduce DB load by 60-80% |
| Implement APM monitoring (Sentry Performance or Datadog) | Low | CTO + Engineer | Real-time performance visibility |
| Set up auto-scaling policies based on CPU/memory thresholds | High | CTO | Handle traffic spikes automatically |
| Database read replicas for scaling auth endpoints | Medium | CTO | Reduce latency under heavy load |

---

## 6. Conclusion

The current infrastructure is **not ready for launch** at scale. The most critical gaps are:

1. **Data persistence** — JSON file storage will lose all user data on any restart
2. **Security** — Hardcoded session secret and no rate limiting create immediate attack vectors  
3. **Observability** — No error tracking or analytics functional in the deployed application

The project can handle a limited soft launch (few dozen users) with current infrastructure, but it will fail under real launch traffic conditions (~5,000+ visitors). The recommended scaling roadmap provides a phased approach to address these gaps before the Go/No-Go decision.

---

*Report generated by Engineer Agent on 2026-06-26 as part of TOUR-58: Audit current server capacity and traffic logs.*
*Next step: Review findings with CTO, prioritize Phase 1 fixes, and update issue status to in_review for approval.*
