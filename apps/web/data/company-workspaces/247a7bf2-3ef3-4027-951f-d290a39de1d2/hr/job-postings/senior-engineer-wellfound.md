# Tourbillon — Senior Backend/Full-Stack Engineer

**Location:** Remote (US / EMEA overlap preferred)  
**Compensation:** $140k–$170k + 0.5%–1.0% equity  
**Type:** Full-time  

---

## About Tourbillon

Tourbillon is building **open-source AI agent orchestration** — a platform that lets teams design, deploy, and manage autonomous AI agents as production systems. We're an early-stage startup backed by strong technical founders with deep experience in distributed systems and AI infrastructure.

Our mission: make it simple to build reliable, scalable multi-agent workflows that solve real business problems. Think of us as the infrastructure layer between AI models and enterprise operations.

**Why join us?**
- 🚀 Early-stage equity (0.5%–1%) at a company with clear product-market fit trajectory
- 🔧 Deep technical work: you'll own critical platform features from day one
- 🌍 Fully remote, async-first culture with flexible hours
- 💡 Direct impact on product direction — no bureaucracy, just shipping

---

## The Role

We're looking for a **Senior Backend/Full-Stack Engineer** who thrives in fast-moving environments and can own complex features end-to-end. You'll be responsible for core platform services including Stripe billing integration, developer tooling, API design, and infrastructure at scale.

This is not a "ticket-taker" role. We need someone who can architect systems, make independent technical decisions, mentor junior engineers, and ship production-quality code under tight timelines.

---

## What You'll Own

### Core Platform Features
- Design and implement backend services using **TypeScript** with **Next.js App Router**
- Build and maintain the **Stripe Billing integration**: subscription schema, webhook processing, invoice lifecycle, and user-facing billing dashboard
- Architect and ship **API endpoints** (server actions / API routes) consumed by our frontend and third-party integrations

### Infrastructure & Developer Experience
- Drive **database schema design** and migrations using **Prisma + PostgreSQL** — optimize for performance at scale
- Implement **caching strategies** with Redis (session caching, rate limiting, pub/sub patterns)
- Build integrations: Auth0/OIDC SSO, GitHub webhooks, Slack notifications, generic webhook endpoints

### Quality & Operations
- Implement **performance monitoring**, error tracking, and CI/CD pipelines
- Write clean, well-tested code with comprehensive unit and integration tests (Jest, Supertest)
- Mentor our existing engineer on best practices, code reviews, and architecture patterns

---

## What We're Looking For

### Must-Have Skills
| Skill | Proficiency Level |
|-------|------------------|
| **TypeScript** | Production-level fluency — generics, utility types, discriminated unions, type inference |
| **Next.js** | App Router, server components, API routes, middleware patterns |
| **Prisma ORM** | Schema design, migrations, query optimization (select/include), raw SQL when needed |
| **PostgreSQL** | Index strategies, JSONB queries, transaction isolation, connection pooling |
| **Redis** | Caching patterns, pub/sub, rate limiting, session management |
| **Node.js** | Event loop understanding, streams, error handling, middleware architecture |
| **CI/CD** | GitHub Actions workflows, automated testing, deployment pipelines |
| **Testing** | Jest, Supertest — writing meaningful integration tests, not just coverage metrics |

### Nice-to-Have (Bonus Points)
- Stripe Billing SDK experience and webhook idempotency patterns
- Auth0 / OIDC / SSO implementation
- Docker & Docker Compose for local development
- Observability tools: Datadog, Grafana, Mixpanel
- FaaS deployment (Vercel Serverless, Cloudflare Workers)

---

## Interview Process (3 Rounds — ~3.5 Hours Total)

### Round 1: Technical Screen (60 min)
Live coding exercise in TypeScript. Examples:
- Implement a webhook idempotency handler with deduplication
- Build a rate limiter using sliding window algorithm
- Design a subscription state machine for billing lifecycle

### Round 2: System Design (90 min)
End-to-end architecture exercise focused on Tourbillon's domain:
- Design the billing system: Prisma schema → webhook processing pipeline → user dashboard
- Discuss tradeoffs: synchronous vs async webhook handling, retry strategies, data consistency models
- Scalability considerations for 1000+ concurrent users

### Round 3: Final Interview (60 min)
- Culture fit and collaboration style
- Deep dive into your past projects — what you built, why, and lessons learned
- Code review exercise: evaluate a real code sample from our stack and provide constructive feedback

---

## Compensation & Benefits

| Component | Details |
|-----------|---------|
| **Base Salary** | $140k–$170k (based on experience level) |
| **Equity** | 0.5% – 1.0% Series A vesting schedule (4-year, 1-year cliff) |
| **Remote** | Fully remote — US or EMEA time zone overlap preferred |
| **Equipment** | Laptop provided, home office stipend |
| **Learning** | Annual conference/training budget |

---

## How to Apply

Click "Apply Now" on Wellfound and include:
1. Your resume / LinkedIn profile
2. Links to relevant projects or open-source contributions
3. A brief note about why you're interested in Tourbillon and AI agent orchestration

We review all applications within 48 hours and aim to schedule technical screens within one week of application.

---

*Tourbillon is an equal opportunity employer. We celebrate diversity and are committed to creating an inclusive environment for all employees.*
