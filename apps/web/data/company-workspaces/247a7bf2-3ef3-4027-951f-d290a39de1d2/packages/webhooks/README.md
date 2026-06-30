# @tourbillon/webhooks

Webhook dispatch, routing, and filtering engine for tourbillon.org.

## Features

- **Event-based routing**: Register endpoints that listen to specific event types
- **Wildcard matching**: Use `custom.*` or `*` patterns to match multiple event types
- **HMAC-SHA256 signatures**: Verify incoming webhook payloads with constant-time comparison
- **Automatic retries**: Configurable retry logic with exponential backoff for 5xx errors and timeouts
- **Type-safe**: Full TypeScript support

## Usage

```typescript
import { registerEndpoint, dispatchEvent, verifySignature } from './src/service';

// Register an endpoint to receive events
const epId = registerEndpoint({
  url: 'https://example.com/hook',
  secret: 'my-secret-key',
  events: ['feedback.submitted', 'nps.response'],
  timeoutMs: 5000,
  maxRetries: 3,
});

// Dispatch an event to all matching endpoints
await dispatchEvent({
  id: 'evt_123',
  type: 'feedback.submitted',
  timestamp: new Date(),
  data: { userId: 'user_456', rating: 5 },
});

// Verify incoming webhook signatures
const isValid = verifySignature(
  payload,
  signatureHeader,
  'my-secret-key'
);
```

## Event Types

| Type | Description |
|------|-------------|
| `feedback.submitted` | User submitted feedback form |
| `nps.response` | NPS survey response received |
| `user.created` | New user registration |
| `payment.received` | Payment processed successfully |
| `custom.*` | Custom events matching the pattern |

## Running Tests

```bash
# From this directory:
npm install
npm test

# Or directly with ts-node:
npx tsx src/service.test.ts
```

## CI/CD Pipeline

The GitHub Actions workflow is located at `.github/workflows/ci.yml` in the repository root. It runs on push to `main` and all pull requests, performing:

1. Dependency installation
2. Linting
3. Type checking / build verification
4. Webhook service test execution
5. Export validation (ensures all expected functions are exported)
6. Deployment trigger (on main branch pushes only)

## License

MIT
