// ============================================================================
// TOUR-100: Webhooks Re-export for Next.js API Routes
// 
// Provides convenient imports from @/lib/webhooks/service
// ============================================================================

export {
  registerEndpoint,
  getActiveEndpoints,
  verifySignature,
  generateSignature,
  dispatchToEndpoint,
  dispatchEvent,
  handleVerification,
  getEndpointStats,
} from '@tourbillon/webhooks/service';

export type { WebhookEvent, WebhookEndpoint, DispatchResult } from '@tourbillon/webhooks/service';
