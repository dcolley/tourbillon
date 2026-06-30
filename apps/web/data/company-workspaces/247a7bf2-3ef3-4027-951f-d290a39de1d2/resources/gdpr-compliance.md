# Tourbillon GDPR & CCPA Compliance Framework

**Document Owner:** COO
**Last Updated:** 2026-06-25
**Status:** Draft — Requires CEO Legal Review (TOUR-53)

## Purpose

This document outlines Tourbillon's compliance measures for the EU General Data Protection Regulation (GDPR, effective May 25, 2018), California Consumer Privacy Act (CCPA/CPRA), and related data protection regulations. This is a prerequisite for our public launch.

***

## Part A: GDPR Compliance (EU/EEA)

### 1. Legal Basis for Processing

Tourbillon processes personal data under the following lawful bases (Article 6 GDPR):

| Processing Activity                     | Legal Basis                   | Article Reference           |
| --------------------------------------- | ----------------------------- | --------------------------- |
| Account creation & authentication       | Contract performance          | Art. 6(1)(b)                |
| Service delivery & feature usage        | Contract performance          | Art. 6(1)(b)                |
| Analytics (Google Analytics anonymized) | Legitimate interest           | Art. 6(1)(f)                |
| Security monitoring & fraud prevention  | Legitimate interest           | Art. 6(1)(f)                |
| Email communication for service updates | Legitimate interest / Consent | Art. 6(1)(f) / Art. 6(1)(a) |
| Marketing communications (opt-in only)  | Consent                       | Art. 6(1)(a)                |

### 2. Data Subject Rights & Fulfillment Process

Tourbillon will fulfill the following data subject rights within **30 days** of receipt:

#### Right to Access (Article 15)

* Users can request all personal data we hold about them via [`privacy@tourbillon.dev`](mailto:privacy@tourbillon.dev)
* Response includes: categories of data, purposes, recipients, retention periods, source
* Format: Machine-readable JSON or PDF export within 30 days

#### Right to Rectification (Article 16)

* Users can request correction of inaccurate personal data at any time via settings portal or support ticket
* Corrections applied within 7 business days

#### Right to Erasure / "Right to Be Forgotten" (Article 17)

**Procedure:**

1. User submits deletion request via settings → "Delete Account" or email [`privacy@tourbillon.dev`](mailto:privacy@tourbillon.dev)
2. Identity verification completed (OAuth provider confirmation required)
3. Personal data deleted from active systems within 30 days
4. Backups retain anonymized data for up to 90 days per our retention schedule
5. User receives confirmation of deletion

**Exceptions where erasure may be denied:**

* Legal obligation requiring data retention (e.g., tax records, fraud investigation)
* Legitimate interests that override individual rights (documented and justified)

#### Right to Restriction of Processing (Article 18)

* Users can request temporary restriction of processing during dispute resolution
* Restricted data will be stored but not actively processed
* User notified when restriction is lifted

#### Right to Data Portability (Article 20)

* Export functionality available in user settings ("Export My Data")
* Available formats: JSON, CSV
* Includes all user-provided content and usage history

#### Right to Object (Article 21)

* Users may object to processing based on legitimate interests at any time
* Marketing opt-out via email footer link or settings dashboard
* Tourbillon will cease processing unless it demonstrates compelling legitimate grounds

### 3. Data Processing Agreements (DPAs)

Tourbillon has executed DPAs with the following subprocessors:

| Subprocessor        | Service              | DPA Status            | Location   |
| ------------------- | -------------------- | --------------------- | ---------- |
| \[Hosting Provider] | Cloud infrastructure | ☐ Executed / ✅ Active | \[Country] |
| Google LLC          | Analytics (GA4)      | ✅ Via EU SCCs         | USA        |
| \[Sentry/Other]     | Error monitoring     | ☐ To be executed      | \[Country] |

*All subprocessors must be listed in a publicly available Subprocessor Register.*

### 4. Data Transfers Outside the EEA

Where data is transferred outside the European Economic Area:

* **Mechanism:** Standard Contractual Clauses (SCCs) adopted by EU Commission Decision 2021/914
* **Transfer Impact Assessments** conducted for each destination country
* **Supplementary measures** implemented where needed (encryption, pseudonymization)

### 5. Data Protection by Design and Default (Article 25)

Tourbillon implements the following privacy-enhancing measures:

* Pseudonymization of analytics data before transmission to Google Analytics
* Encryption in transit (TLS 1.3+) for all data transmissions
* Encryption at rest for stored user credentials and sensitive configuration data
* Minimal data collection — only data necessary for service delivery is collected
* Privacy by default settings — users control maximum privacy out-of-the-box

### 6. Data Breach Notification Procedure (Article 33-34)

**In the event of a personal data breach:**

| Timeframe           | Action                                                | Owner                  |
| ------------------- | ----------------------------------------------------- | ---------------------- |
| Within 24 hours     | Internal incident assessment and containment          | CTO / Security Lead    |
| Within 72 hours     | Notification to Supervisory Authority (if required)   | CEO / Legal            |
| Without undue delay | Notification to affected data subjects (if high risk) | PM + CMO communication |

**Breach Registry:** All incidents, regardless of severity, logged in internal incident log.

### 7. EU Representative

*\[To be appointed before launch — required for non-EU companies processing EU resident data]*

* Name: \[TBD]
* Address: \[TBD]
* Contact: \[email]

***

## Part B: CCPA / CPRA Compliance (California)

### 1. Scope

This policy applies to personal information of California residents as defined under the California Consumer Privacy Act (CCPA, effective Jan 1, 2020) and its amendment, the California Privacy Rights Act (CPRA, effective Jan 1, 2023).

### 2. Categories of Personal Information Collected

| Category               | Examples                                   | Purpose                      | Sources                  |
| ---------------------- | ------------------------------------------ | ---------------------------- | ------------------------ |
| Identifiers            | Name, email, IP address                    | Account management, security | Directly from user       |
| Commercial information | Usage data, feature preferences            | Service delivery, analytics  | Automatic collection     |
| Internet activity      | Browsing history on our site, session data | Analytics, fraud prevention  | Cookies, automatic       |
| Geolocation data       | City-level (anonymized)                    | Usage metrics                | IP address (approximate) |

**We do NOT:** Collect sensitive personal information (SSN, financial accounts, precise geolocation), sell personal information, or process data of known minors under 16.

### 3. Consumer Rights Under CCPA/CPRA

California residents may exercise the following rights:

| Right                                                | How to Exercise                                                           | Response Timeframe                       | Verification Required           |
| ---------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------- |
| Right to Know (categories + specific pieces of data) | Email `privacy@tourbillon.dev` or via account settings                    | 45 days (+ 45 day extension if notified) | Account login or verified email |
| Right to Delete                                      | Via account settings "Delete My Data"                                     | 45 days                                  | Account login required          |
| Right to Correct inaccurate PII                      | Via account settings or support request                                   | 15 business days                         | Account login required          |
| Right to Opt-Out of Sale/Sharing (if applicable)     | Global Privacy Control signal + website link                              | Immediate effect                         | Not required                    |
| Right to Limit Use of Sensitive PII (CPRA)           | Not applicable — we do not collect sensitive PII                          | N/A                                      | N/A                             |
| Right to Non-Discrimination                          | Automatic — no different pricing or service quality for exercising rights | Continuous                               | N/A                             |

### 4. "Do Not Sell or Share My Personal Information" Link

*\[To be added to website footer and privacy policy]*

* Link text: "Do Not Sell or Share My Personal Information"
* Points to a page confirming we do NOT sell personal information
* Complies with Global Privacy Control (GPC) signals

### 5. Service Provider / Contractor Restrictions

Tourbillon's subprocessors are contractually prohibited from selling/sharing user data and may only process it for specified purposes. DPA provisions include CCPA-specific requirements.

***

## Part C: Cookie Consent & Transparency

### 1. Cookie Categories

| Category                            | Purpose                           | Required? | Opt-Out? |
| ----------------------------------- | --------------------------------- | --------- | -------- |
| Essential (session, authentication) | Login, security, user preferences | ✅ Yes     | ❌ No     |
| Analytics (Google Analytics)        | Usage metrics, improvement        | ☐ No      | ✅ Yes    |
| Marketing / Tracking                | None currently in use             | ☐ No      | N/A      |

### 2. Cookie Banner Implementation

* [ ] First-party cookie banner on initial visit explaining consent preferences
* [ ] Options to accept essential only, or allow analytics cookies
* [ ] Preference stored in user's browser for subsequent visits
* [ ] Link to Privacy Policy and Cookie Policy (if separate)

***

## Compliance Readiness Checklist

| Item                                               | Status    | Owner             | Notes                                     |
| -------------------------------------------------- | --------- | ----------------- | ----------------------------------------- |
| Privacy Policy drafted                             | ✅ Done    | PM Harness        | `resources/privacy-policy.md`             |
| Terms of Service drafted                           | ✅ Done    | PM Harness        | `resources/terms-of-service.md`           |
| GDPR DPA executed with all subprocessors           | ☐ Pending | CEO / Legal       | Host + Sentry/etc.                        |
| EU Representative appointed                        | ☐ Pending | CEO               | Required before launch if non-EU entity   |
| Cookie consent banner implemented                  | ☐ Pending | CTO / Engineering | See TOUR-52 for monitoring setup          |
| Subprocessor register published                    | ☐ Pending | PM                | Must list all third-party data processors |
| Data Protection Impact Assessment (DPIA) completed | ☐ Pending | CEO / Legal       | Required if processing is high-risk       |
| Staff training on GDPR procedures completed        | ☐ Pending | All team leads    | Awareness of breach notification process  |

***

*This document supports TOUR-53 (Legal Compliance Review) and must be reviewed by the CEO or external legal counsel before launch.*