# Developer Portal Audit & Wireframes

## Audit Summary

### Existing Pages
- `/docs` - Index
- `/docs/agent-config` - Agent Configuration Guide
- `/docs/api-reference` - API Reference
- `/docs/quality-guide` - Quality Guide
- `/docs/deployment` - Deployment Guide
- `/docs/goal-project-management` - Goal & Project Management

### Target Features (from TOUR-113)
1. **My Integrations** - Connected services overview
2. **API Keys** - Create/manage secret & public keys
3. **Webhooks** - Configure and monitor webhook endpoints
4. **Rate Limits** - Real-time usage vs. quota
5. **Token Expiry** - Session & refresh token status
6. **Usage Analytics** - Charts for requests, latency, success rate

### Gap Analysis

| Feature | Status | Gaps |
|---------|--------|------|
| Integrations | Partial (Slack, GitHub, Google auth) | No unified integrations dashboard |
| API Keys | Not in UI | Keys live in `auth.ts` but no user-facing CRUD |
| Webhooks | Backend API exists | No UI to configure, pause, test endpoints |
| Rate Limits | `rate-limit.ts` exists | No visual dashboard or quota breakdown |
| Token Expiry | Session route exists | No expiry overview or refresh controls |
| Usage Analytics | GA4 tracked | No in-portal analytics view |

## Wireframes

### 1. Developer Dashboard (`/developer`)

```
+-----------------------------------------------------------------------+
| Logo  Tourbillon Developer Portal                     [User ▼]        |
| +--------------------------------------------------------------------- |
|                                                                       |
|  Overview                                                                |
|                                                                       |
|  +-----------------+ +-----------------+ +------------------+        |
|  | API Status        | Integrations  | Quota Usage          |        |
|  | ? All Systems     | 3 connected   | 3.2K / 10K          |        |
|  |                |               | -----░░░░░ 32%         |        |
|  +-----------------+ +-----------------+ +------------------┘        |
|                                                                       |
|  Recent Activity                                                       |
|  • Webhook delivered to Slack — 5m ago                               |
|  • API key sk_live_...xM7d — created 2h ago                           |
|  • Rate limit reset — 3d ago                                          |
|                                                                       |
|  Quick Actions                                                         |
|  [Generate API Key] [Add Webhook] [Connect Slack]                      |
|                                                                       |
+-----------------------------------------------------------------------+
```

### 2. API Keys (`/developer/api-keys`)

```
+-----------------------------------------------------------------------+
| Developer Portal > API Keys                               [New Key]  |
| ------------------------------------------------------------------+ |
|                                                                       |
|  +------------------------------------------------------------------------|
| |  sk_live_4eC39H...  copy   ✎                                         |
| |  Created Jun 10 • Last used 2h ago                                  |
| |  Permissions: Goals, Issues, Projects, Tokens                        |
| ?------------------------------------------------------------------------
| ?
|  +------------------------------------------------------------------------|
| |  pk_live_8dE22n...  copy   ✎                                          |
| |  Created Jun 20 • Last used 5d ago                                   |
| |  Permissions: Read-only (Goals, Issues)                             |
| |  Environment: Live                                                   |
| ?-------------------------------------------------------------------
|
-----------------------------------------------------------------------+
```

### 3. Webhooks (`/developer/webhooks`)

```
+-----------------------------------------------------------------------+
| Developer Portal > Webhooks                           [Add Endpoint]  |
| -------------------------------------------------------------------┘
|                                                                       |
|  +---------------------------------------------------------------------|
| |  +-------------------------------------------------------------------|
| | https://app.example.com/hooks/tourbillon                            |
| |  Status: Active  ●  Last delivered: 5m ago                         |
|  └─────────────────────────────────────────────────────────────────┘      
|   
|  
|  +---------------------------------------------------------------------|
|  | +-------------------------------------------------------------------ν
|  │  Status: Active  ●  Last delivered: 2h ago                                                      │
|  +-------------------------------------------------------------------┘      
|   
|  
------------------------------------------------------------------------
|                                                                       |
+-----------------------------------------------------------------------+
```

### 4. Rate Limits (`/developer/rate-limits`)

```
+-----------------------------------------------------------------------+
| Developer Portal > Rate Limits                                       |
| ------------------------------------------------------------------┘ |
|                                                                       |
|  +-----------------------------------------------------------------------|
|  ●
|
└──────────────────────────────────────────────────────────────
|  +-----------------------------------------------------------------------+
|  │ │
|  └──────────────────────────────────────────────────────────────────┘    
|  
|  ┌────────────────────────────────────────────────────────────────┘
|  │ 
|  
|  [Upgrade to Enterprise]        │
|                                                                   |
+-----------------------------------------------------------------------+
```

### 5. Token Expiry (`/developer/tokens`)

```
+-----------------------------------------------------------------------+
| Developer Portal > Tokens                                              |
| └──────────────────────────────────────────────────────────────┘       
|   +------------------------------------------------------|
|  |  
|  └───────────────────────────────────────────────────────────
|  
|  
| Ε--------------------------------------------------------------
|  │
+------------------------------------------------------------------------|
```

### 6. Usage Analytics (`/developer/analytics`)

```
+-----------------------------------------------------------------------+
|
+-----------------------------------------------------------------------+
```

## Next Steps

These wireframes are ready for handoff to the CTO/Engineer for implementation. The focus is on:
- Building reusable components for each section
- Connecting to existing backend APIs
- Adding real-time updates where applicable
