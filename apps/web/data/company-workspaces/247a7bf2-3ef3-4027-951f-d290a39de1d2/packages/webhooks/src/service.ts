// ============================================================================
// TOUR-100: Webhooks Service — Core Dispatch & Routing Engine
// 
// Centralized webhook management for tourbillon.org. Accepts incoming webhook
// events, verifies signatures, and routes to configured endpoints.
//
// Usage in any module:
//   import { registerEndpoint, dispatchEvent } from '@tourbillon/webhooks/service';
// 
// Environment Variables:
//   WEBHOOK_SECRET — Shared secret for HMAC-SHA256 signature verification
// ============================================================================

export type WebhookEventType = 'feedback.submitted' | 'nps.response' | 'user.created' | 'payment.received' | 'custom.*';
export type HttpMethod = 'POST' | 'GET' | 'PUT' | 'PATCH';

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  timestamp: Date;
  data: Record<string, unknown>;
  signature?: string; // For outgoing webhooks that need signing
}

export interface WebhookEndpoint {
  url: string;
  secret: string;
  active: boolean;
  events: WebhookEventType[];
  maxRetries: number;
  timeoutMs: number;
}

export interface DispatchResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

// --- In-Memory Store (replace with DB for production) ---

const endpoints = new Map<string, WebhookEndpoint>();
let endpointCounter = 0;

/**
 * Register a webhook endpoint to receive events.
 */
export function registerEndpoint(config: Omit<WebhookEndpoint, 'active' | 'maxRetries'>): string {
  const id = `endpoint_${++endpointCounter}`;
  
  endpoints.set(id, {
    ...config,
    active: true,
    maxRetries: config.maxRetries || 3,
  });

  return id;
}

/**
 * Get all active endpoints for a given event type.
 */
export function getActiveEndpoints(type: WebhookEventType): Map<string, WebhookEndpoint> {
  const result = new Map<string, WebhookEndpoint>();
  
  for (const [id, endpoint] of endpoints.entries()) {
    if (!endpoint.active) continue;
    
    // Match exact type or wildcard pattern (* matches all)
    const match = endpoint.events.some(event => 
      event === type || event.endsWith('.*') || event === '*'
    );
    
    if (match) {
      result.set(id, endpoint);
    }
  }

  return result;
}

/**
 * Verify HMAC-SHA256 signature of incoming webhook payload.
 * 
 * Expected header: "x-webhook-signature: <signature>"
 */
export function verifySignature(payload: string, signature: string, secret: string): boolean {
  try {
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', secret);
    const digest = hmac.update(payload).digest('hex');
    
    // Constant-time comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(digest, 'hex')
    );
  } catch (error) {
    console.error('[WEBHOOKS] Signature verification failed:', error);
    return false;
  }
}

/**
 * Generate HMAC-SHA256 signature for outgoing webhook payloads.
 */
export function generateSignature(payload: string, secret: string): string {
  const crypto = require('crypto');
  const hmac = crypto.createHmac('sha256', secret);
  return hmac.update(payload).digest('hex');
}

/**
 * Send a webhook event to a single endpoint with retry logic.
 */
export async function dispatchToEndpoint(
  endpoint: WebhookEndpoint,
  event: WebhookEvent
): Promise<DispatchResult> {
  const payload = JSON.stringify({
    id: event.id,
    type: event.type,
    timestamp: event.timestamp.toISOString(),
    data: event.data,
  });

  const signature = generateSignature(payload, endpoint.secret);

  for (let attempt = 1; attempt <= endpoint.maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), endpoint.timeoutMs || 5000);

      const response = await fetch(endpoint.url, {
        method: 'POST' as HttpMethod,
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-Webhook-Event': event.type,
          'X-Webhook-ID': event.id,
        },
        body: payload,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error(`[WEBHOOKS] Endpoint ${endpoint.url} returned ${response.status}:`, errorText);
        
        // Retry on 5xx errors only (not client errors like 401, 403)
        if (response.status >= 500 && attempt < endpoint.maxRetries) {
          await sleep(100 * Math.pow(2, attempt)); // Exponential backoff
          continue;
        }

        return { success: false, statusCode: response.status, error: errorText };
      }

      console.log(`[WEBHOOKS] Successfully dispatched event ${event.type} to ${endpoint.url}`);
      return { success: true, statusCode: response.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      
      if (message.includes('AbortError') || attempt < endpoint.maxRetries) {
        await sleep(100 * Math.pow(2, attempt));
        continue;
      }

      console.error(`[WEBHOOKS] Failed to dispatch to ${endpoint.url} after ${attempt} attempts:`, message);
      return { success: false, error: message };
    }
  }

  return { success: false, error: 'Max retries exceeded' };
}

/**
 * Process a webhook event: verify, route to matching endpoints.
 */
export async function dispatchEvent(event: WebhookEvent): Promise<DispatchResult[]> {
  const targets = getActiveEndpoints(event.type);
  
  if (targets.size === 0) {
    console.log(`[WEBHOOKS] No active endpoints for event type: ${event.type}`);
    return [];
  }

  console.log(`[WEBHOOKS] Dispatching ${event.type} to ${targets.size} endpoint(s)`);

  const results = await Promise.all(
    Array.from(targets.values()).map(endpoint => 
      dispatchToEndpoint(endpoint, event)
    )
  );

  // Log summary
  const successes = results.filter(r => r.success).length;
  if (successes > 0) {
    console.log(`[WEBHOOKS] ${successes}/${results.length} endpoints received the event successfully`);
  } else if (results.some(r => r.error)) {
    console.warn(`[WEBHOOKS] All ${results.length} endpoint dispatch(es) failed for event ${event.id}`);
  }

  return results;
}

/**
 * Handle an incoming webhook verification event (Stripe, etc.).
 */
export function handleVerification(
  payload: string,
  signatureHeader: string | undefined,
  secret?: string
): boolean {
  if (!signatureHeader || !secret) {
    console.warn('[WEBHOOKS] No signature header or secret provided for verification');
    return true; // Allow through for development/testing (no secret configured)
  }

  const valid = verifySignature(payload, signatureHeader, secret);
  
  if (!valid) {
    console.error('[WEBHOOKS] Invalid webhook signature rejected!');
  } else {
    console.log('[WEBHOOKS] Webhook signature verified ✓');
  }

  return valid;
}

/**
 * Health check: list registered endpoints.
 */
export function getEndpointStats(): { total: number; active: number; inactive: number } {
  let active = 0;
  let inactive = 0;

  for (const endpoint of endpoints.values()) {
    if (endpoint.active) active++;
    else inactive++;
  }

  return { 
    total: endpoints.size, 
    active, 
    inactive 
  };
}

// --- Utility Functions ---

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
