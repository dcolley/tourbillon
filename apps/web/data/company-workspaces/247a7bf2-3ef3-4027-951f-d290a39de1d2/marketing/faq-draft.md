# Tourbillon — Frequently Asked Questions (FAQ)

*Last Updated: 2026-06-26 · Version 1.0 (Draft)*

---

## Table of Contents

1. [General](#general)
2. [Getting Started & Setup](#getting-started--setup)
3. [Features & Capabilities](#features--capabilities)
4. [Pricing & Billing](#pricing--billing)
5. [Account & Security](#account--security)
6. [Troubleshooting](#troubleshooting)

---

## General

### What is Tourbillon?

Tourbillon is an open-source **AI agent orchestration platform** that enables you to create, configure, and deploy autonomous AI agents. You can design multi-agent workflows, monitor behavior in real-time, integrate with external tools and data sources, and collaborate on shared workspaces — all through a single intuitive interface.

### Who should use Tourbillon?

Tourbillon is designed for:
- **Teams** that want to automate repetitive workflows using AI agents
- **Developers** who need an orchestration layer for multi-agent systems
- **Businesses** looking to reduce manual effort and increase operational efficiency
- **Anyone interested in experimenting with autonomous AI agent workflows**

### Is Tourbillon open-source?

Yes. Tourbillon incorporates open-source software components governed by their respective licenses (MIT, Apache 2.0, GPL, etc.). The platform itself is available under open-source licensing. See our [Terms of Service](../resources/terms-of-service.md) for details.

### How do I contact Tourbillon support?

- **General Support:** Submit feedback through the in-app feedback channel or email us at `support@tourbillon.dev`
- **Legal Inquiries:** `legal@tourbillon.dev`
- **Privacy Requests:** `privacy@tourbillon.dev`
- **Community Forum / Discord:** Links available in the website footer

---

## Getting Started & Setup

### How do I sign up for Tourbillon?

Visit [tourbillon.io](https://tourbillon.io) and click **Sign Up**. You can create an account using:
- **Email & Password** — Standard registration with email verification
- **Google OAuth** — Single sign-on via your Google account
- **GitHub OAuth** — Single sign-on via your GitHub account

After signing up, verify your email address using the confirmation link sent to your inbox.

### What are the minimum system requirements?

Tourbillon is a cloud-hosted platform — there's nothing to install on your local machine. You only need:
- A modern web browser (Chrome, Firefox, Safari, or Edge)
- An active internet connection
- Access to configure environment variables if self-hosting (see below)

### Can I use Tourbillon without a credit card?

Yes. Tourbillon offers a **free tier** that allows limited usage of the platform's core features. No payment information is required to sign up for or use the free tier.

### What is the recommended first workflow?

We recommend starting simple:
1. Create a Goal (e.g., "Automate our weekly report generation")
2. Create a Project under that Goal
3. Add a Task describing what you want done in plain language
4. Assign an AI Agent to execute it
5. Review the output, approve or provide feedback

This gives you hands-on experience with the core workflow before exploring advanced features like custom agent configurations and project templates.

### Can I self-host Tourbillon?

Yes. Tourbillon supports self-hosted deployments. Configuration is managed through environment variables (`.env`). See our [Deployment Guide](../apps/web/src/app/docs/deployment/page.tsx) for detailed setup instructions, and use the provided `.env` template to get started:
- `SESSION_SECRET` — Your session secret key
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth credentials (optional)
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — GitHub OAuth credentials (optional)
- `NEXT_PUBLIC_BASE_URL` — Your application's base URL

---

## Features & Capabilities

### What can AI Agents do on Tourbillon?

Agents on Tourbillon can:
- Execute tasks based on your descriptions in plain language
- Plan their own approach and break complex work into subtasks
- Create, read, and modify files within shared workspaces
- Interact with external tools and data sources (Slack, GitHub, Notion, Google Drive)
- Collaborate on shared workspace environments with other agents or human users

### What's the difference between Goals, Projects, and Tasks?

Think of it as a hierarchy:
- **Goal** — A strategic objective (e.g., "Improve customer onboarding experience")
- **Project** — A collection of related work toward that goal (e.g., "Onboarding Flow Redesign")
- **Task / Subtask** — Individual pieces of work assigned to an agent or team member

### Can I save my project as a template?

Yes. You can save any project structure as a reusable template:
1. Navigate to the project you want to save
2. Click **⋯ (More actions)** → **Save as Template**
3. Use this template to quickly create new projects with the same structure

### How do I invite team members?

Go to **Settings → Team & Members**, then:
- Enter email addresses directly, or
- Share an invite link
Available roles are **Admin**, **Editor**, and **Viewer**. No setup is required on the invited user's end.

### Can I customize agent behavior?

Yes. Go to **Settings → Agents** to define custom prompts and tool configurations for each agent. This allows you to tailor how agents plan, communicate, and execute work based on your specific needs.

### What integrations are available?

Tourbillon supports integrations with popular tools including:
- Slack
- GitHub
- Notion
- Google Drive

Integration availability may vary by subscription tier. Check Settings → Integrations for the full list.

---

## Pricing & Billing

### How does Tourbillon pricing work?

**Free Tier:** Available at no cost with limited usage. No payment required to sign up.

**Paid Tiers:** Additional tiers are available for higher usage limits and premium features. Specific pricing, plans, and feature breakdowns will be communicated before purchase. Visit our website or contact sales for current pricing information.

### How is billing handled?

All fees are processed through designated third-party payment providers and are subject to applicable taxes. You can manage your subscription and payment methods from Settings → Billing.

### What is the refund policy?

We offer refunds within a defined period after initial purchase for new subscribers. Refund requests submitted after this window may be considered at Tourbillon's discretion on a case-by-case basis. Contact support for details about your specific situation.

---

## Account & Security

### How do I secure my account?

- Use strong, unique passwords (if using email/password authentication)
- Enable OAuth via Google or GitHub for managed authentication
- Keep your credentials confidential — never share login information
- Notify us immediately of any unauthorized access to your account

### What happens if someone accesses my account without permission?

Tourbillon reserves the right to suspend or terminate accounts exhibiting suspicious activity. You are responsible for all actions taken through your account, so prompt notification is critical. Contact us at `support@tourbillon.dev` immediately if you suspect unauthorized access.

### How does Tourbillon handle my data?

Tourbillon follows industry-standard security practices:
- **Encryption in transit** (TLS/SSL) for all data transmissions
- **Secure authentication** via OAuth providers and hashed passwords
- **Regular security reviews** and vulnerability assessments
- **Access controls** limiting employee access to user data on a need-to-know basis

Our full data handling practices are documented in our [Privacy Policy](../resources/privacy-policy.md). In summary: we do not sell your personal information, and you retain ownership of content created through the Service.

### What data does Tourbillon collect?

- **Account Information:** Name, email address (via OAuth or manual entry)
- **Usage Data:** Agent configurations, workflows created, feature usage metrics
- **Device Information:** IP address, browser type, operating system, access times
- **Analytics:** Google Analytics cookies for understanding user behavior

### What are my data rights?

Under GDPR and CCPA, you have the right to:
- **Access** a copy of your personal data
- **Rectify** inaccurate or incomplete data
- **Erasure** request deletion of your data ("right to be forgotten")
- **Portability** receive your data in a structured, machine-readable format
- **Object** to processing based on legitimate interests

To exercise any of these rights, contact `privacy@tourbillon.dev`. We respond within 30 days.

### How long is my data retained after account deletion?

- Account data and user profile information: deleted within **30 days**
- Backups may retain anonymized data for up to **90 days**
- Analytics data may be retained in aggregated, anonymized form indefinitely

---

## Troubleshooting

### I can't log in. What should I do?

1. **Forgot password?** Use the "Forgot Password" link on the login page if you signed up with email/password.
2. **OAuth issue?** Check that your Google or GitHub account is active and properly configured.
3. **Account not verified?** Confirm your email by clicking the verification link sent during signup.
4. **Still stuck?** Contact support at `support@tourbillon.dev` with your email address and a description of the issue.

### My agent didn't complete a task. What now?

1. Check the **Agent Activity** feed for error messages or failure notifications
2. Review the task comments — the agent may have left explanation there
3. Provide feedback or ask a follow-up question directly on the task thread
4. If the issue persists, contact support via in-app feedback or `support@tourbillon.dev`

### The platform is slow or unresponsive.

1. Check our status page (link in footer) for known incidents
2. Clear your browser cache and try again
3. Try a different browser to rule out local issues
4. If the problem persists, report it via the feedback channel with details about:
   - What you were doing when it happened
   - Your browser and version
   - Any error messages displayed

### How can I submit feature requests or general feedback?

Use the **in-app feedback** channel to submit suggestions, bug reports, or general comments. Feedback is automatically categorized (bug, feature request, billing, etc.) and routed to the appropriate team. You'll receive updates as your feedback progresses through our support pipeline.

### What are Tourbillon's support response times?

We operate a tiered support system:

| Tier | Response Target | Channel |
|------|----------------|---------|
| **Automated (Tier 1)** | <5 minutes | Self-service bot, FAQ, troubleshooting flows |
| **Community/Docs (Tier 2)** | <2 hours | Knowledge base suggestions, community forum |
| **Human Agent (Tier 3)** | <4 hours (business days) / next-day (after-hours) | Direct email or in-app chat support |

Free-tier users receive best-effort support. Paid subscribers may have accelerated response times based on their plan tier. See our [Support SLA](./support-sla.md) for full details.

### How do I cancel my subscription?

Go to **Settings → Billing** and follow the cancellation flow. Your access to paid features will cease at the end of your current billing period. For assistance, contact support at `support@tourbillon.dev`.

### How do I delete my account entirely?

You can terminate your account at any time via the account deactivation procedures in **Settings → Account**. Upon deletion:
- Access to paid features ceases immediately
- Data is removed per our [Privacy Policy](../resources/privacy-policy.md) retention schedule (see "How long is my data retained" above)
- Outstanding fees become immediately due

---

*This FAQ is a draft for post-launch customer support preparation. All contact emails, pricing details, and external links are placeholders pending final review by the CEO.*