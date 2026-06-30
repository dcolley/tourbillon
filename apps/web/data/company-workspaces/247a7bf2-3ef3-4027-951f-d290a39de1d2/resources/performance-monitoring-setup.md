# Tourbillon Performance Monitoring & Alerting Configuration (TOUR-154)

**Date:** 2026-06-29  
**Status:** Implemented  

---

## SLO Targets

| Metric | Target | Current Implementation | Status |
|--------|--------|----------------------|--------|
| Uptime | 99.9% (24h) | `calculateUptime(24)` from `/api/health` | ✅ Implemented |
| Error Rate | <1% (24h) | `calculateErrorRate(24)` tracks client/server errors | ✅ Implemented |
| API p95 Latency | <500ms | `calculateP95ResponseTime(24)` from request metrics | ✅ Implemented |
| Page Load Time | <2s (LCP) | `calculateAvgPageLoadTime(24)` estimates from API latency | ⚠️ Proxy metric (needs RUM data) |

---

## Health Check Endpoints

### `GET /api/health`
Returns service status, uptime, memory usage, and SLO compliance.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-06-29T05:13:30Z",
  "uptimeSeconds": 86400,
  "memoryUsage": {
    "rss": "128MB",
    "heapTotal": "64MB",
    "heapUsed": "32MB"
  },
  "slos": {
    "uptime": { "target": "99.9%", "current": "100%", "status": "passing" },
    "errorRate": { "target": "<1%", "current": "0.5%", "status": "passing" },
    "apiP95ResponseTime": { "target": "<500ms", "current": "245ms", "status": "passing" },
    "pageLoadTime": { "target": "<2000ms", "current": "890ms", "status": "passing" }
  },
  "alerts": []
}
```

### `GET /api/performance/dashboard?window=24`
Returns comprehensive metrics for internal dashboard.

---

## Alerting Configuration

### Automated Checks (Run on Health Endpoint)
- **Critical:** Uptime <99.9% → Send Slack/PagerDuty alert immediately
- **Warning:** Error Rate >1% → Send Slack alert
- **Warning:** API p95 >500ms → Send Slack alert  
- **Info:** Page Load >2s → Log for review

### Alert Delivery Channels (Configurable via env vars)
| Channel | Environment Variable | Status |
|---------|---------------------|--------|
| Slack Webhook | `SLACK_WEBHOOK_URL_ALERTING` | ⚠️ Needs configuration |
| PagerDuty | `PAGERDUTY_API_KEY` | Not yet implemented |
| Datadog | `DATADOG_API_KEY` | API endpoint ready, needs key |
| Grafana Cloud | `GRAFANA_INSTANCE_ID`, `GRAFANA_API_KEY` | API endpoint ready, needs keys |

---

## Integration Guide

### 1. External Uptime Monitors (Pingdom / UptimeRobot)
Configure to ping: `https://tourbillon.io/api/health` every 1 minute  
Expected response: HTTP 200 with `"status": "healthy"`

### 2. Datadog Integration (Optional)
```bash
# Install Datadog Agent or use APM library
pip install ddtrace  # For Python services
npm install @datadog/datadog-api-client  # For Node.js

# Environment variables required:
export DATADOG_API_KEY="your-datadog-key"
export DD_ENV="production"
```

Metrics are sent via `sendToDatadog()` function in `/lib/performance-monitoring.ts`.

### 3. Grafana Cloud Integration (Optional)
```bash
# Environment variables required:
export GRAFANA_INSTANCE_ID="your-instance-id"
export GRAFANA_API_KEY="your-grafana-key"
```

Metrics are sent via `sendToGrafana()` function in `/lib/performance-monitoring.ts`.

### 4. PagerDuty Integration (Coming Soon)
Requires PagerDuty Events API key and integration setup.

---

## Monitoring Dashboard

**URL:** `/performance/dashboard`  
**Access:** Internal team only (not public-facing)

The dashboard displays:
- SLO status cards (Uptime, Error Rate, API p95, Page Load)
- Active alerts with severity levels
- Uptime status grid (last 24h)
- Error counts and total requests
- Auto-refresh every 30 seconds

---

## CI/CD Pipeline Integration

### Pre-deployment Checks
```yaml
# In CI workflow, before deploying to production:
- name: Run health check
  run: curl -f https://staging.tourbillon.io/api/health || exit 1
```

### Post-deployment Validation
```bash
# After deploy, verify SLO compliance within 5 minutes:
curl https://tourbillon.io/api/performance/dashboard?window=0.1 | jq '.metrics'
```

---

## Cost Notes

| Tool | Cost at Launch | Setup Status |
|------|---------------|-------------|
| Built-in monitoring | $0 (in-memory) | ✅ Implemented |
| Datadog APM | Free tier → $15+/node/hr | API ready, key needed |
| Grafana Cloud | 50k samples/mo free | API ready, keys needed |
| PagerDuty | Free for 2 users | Not yet integrated |

**Total monthly cost at launch: $0** (all built-in monitoring)  
**With Datadog integration: ~$15-30/month** depending on traffic volume

---

## Next Steps

1. [ ] Configure `SLACK_WEBHOOK_URL_ALERTING` in production environment
2. [ ] Create PagerDuty account and integrate for critical alerts
3. [ ] Set up real browser performance monitoring (LCP, FID) via GA4 or RUM library
4. [ ] Create Grafana dashboard from exported metrics
5. [ ] Schedule weekly SLO review meeting with engineering team

---

*Implemented by Engineer agent for Q4 Platform Stability (TOUR-154)*
