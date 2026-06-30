# Tourbillon Data Retention Policy

**Document Owner:** COO
**Last Updated:** 2026-06-25
**Status:** Draft — Requires CEO Approval (TOUR-53)

## Purpose

This policy defines how long Tourbillon retains different categories of user data, in compliance with GDPR's storage limitation principle (Article 5(1)(e)) and CCPA requirements.

***

## Data Retention Schedule

### Account & Authentication Data

| Data Type                    | Retention Period                             | Destruction Method                                        | Legal Basis                              |
| ---------------------------- | -------------------------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| Active account credentials   | Duration of account + 30 days after deletion | Secure overwrite/delete                                   | Contract performance (GDPR Art. 6(1)(b)) |
| OAuth provider tokens        | Duration of active session / refresh period  | Automatic expiry, immediate revocation on logout/deletion | Legitimate interest (GDPR Art. 6(1)(f))  |
| Login history (for security) | 90 days                                      | Automatic deletion after retention period                 | Security / legitimate interest           |

### User-Generated Content & Workspace Data

| Data Type                        | Retention Period                                         | Destruction Method                | Legal Basis                                  |
| -------------------------------- | -------------------------------------------------------- | --------------------------------- | -------------------------------------------- |
| Agent configurations, workflows  | Until account deletion + 30 days (export window)         | Secure delete on retention expiry | Contract performance (GDPR Art. 6(1)(b))     |
| Shared workspace content         | Per workspace member agreement + 30 days after departure | Secure delete                     | User agreement / contract                    |
| Support tickets & communications | 2 years from resolution date                             | Secure deletion after period      | Legitimate business interest / legal defense |

### System & Technical Data

| Data Type                         | Retention Period                 | Destruction Method                           | Legal Basis                             |
| --------------------------------- | -------------------------------- | -------------------------------------------- | --------------------------------------- |
| Application error logs (Sentry)   | 90 days                          | Automatic purge from error monitoring system | Security debugging, legitimate interest |
| Server access logs                | 30 days                          | Log rotation with secure deletion            | Operational security                    |
| Analytics data (Google Analytics) | 14 months (default GA retention) | Per Google's data deletion policy            | Legitimate interest / consent-based     |

### Backup Data

| Item                | Retention Period | Notes                                                                                                                                                                               |
| ------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full system backups | 90 days maximum  | Contains anonymized/aggregated data where possible. Personal data is automatically purged from restored backups that exceed retention periods during routine backup refresh cycles. |

***

## Data Destruction Procedures

### Active System Deletion

When a user account is deleted:

1. Immediate deactivation of account and all associated credentials
2. Within 7 days: removal from active application databases (soft delete → hard delete)
3. Within 30 days: permanent deletion from all production systems and caches
4. Backup retention handled separately per the backup schedule above

### Secure Deletion Standards

All deleted personal data is destroyed using industry-standard methods:

* Database records: Direct SQL DELETE with confirmation of cascade deletes where applicable
* File storage: Cryptographic erasure (overwriting with random bytes) for attached files
* Cache systems: Invalidated and purged via cache flush

***

## Exceptions to Retention Periods

Data retention periods may be extended in the following circumstances:

1. **Legal Obligation:** If required by law (e.g., tax records, fraud investigation, regulatory compliance), data will be retained for the duration of that obligation
2. **Ongoing Disputes/Litigation:** Data relevant to a dispute or legal proceeding may be retained until resolution
3. **Security Incidents:** Data related to an active security investigation may be preserved until the matter is resolved

In all cases, extended retention will be documented and reviewed periodically.

***

## Automated Deletion Implementation

| System               | Mechanism                                                                                         | Schedule               |
| -------------------- | ------------------------------------------------------------------------------------------------- | ---------------------- |
| Application database | Scheduled job (cron) checks `deleted_at` timestamp → hard deletes records > 30 days post-deletion | Daily execution        |
| Analytics platform   | Google Analytics auto-expiration at 14 months; configurable in GA settings                        | Per GA policy          |
| Error monitoring     | Sentry retention policy set to 90 days for error events                                           | Automatic per provider |

***

## Review & Compliance

This Data Retention Policy will be reviewed:

* **Annually** as part of our compliance audit process
* Whenever significant changes are made to data collection or processing activities
* Upon regulatory changes that impact retention obligations

**Review Owner:** CEO / Legal Counsel
**Last Reviewed:** 2026-06-25

***

*This document supports TOUR-53 (Legal Compliance Review) and is a component of Tourbillon's GDPR/CCPA compliance framework.*