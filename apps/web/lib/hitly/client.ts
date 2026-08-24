import type { HitlyGateSettings } from '@tourbillon/shared';

export interface HitlyIngestPayload {
  plugin: 'http';
  projectId: string;
  runId: string;
  actionName: string;
  contextMarkdown: string;
  metadata: Record<string, unknown>;
  resumeUrl: string;
  args?: Record<string, unknown>;
  allowedActions?: Array<{ id: string; label: string }>;
  editableFields?: string[];
  editReason?: string;
  externalUrls?: Array<{ url: string; label?: string }>;
}

export interface HitlyIngestResponse {
  id: string;
  status: string;
  replayed?: boolean;
  envelope?: Record<string, unknown>;
}

export interface HitlyResumePayload {
  decision: string;
  id?: string;
  metadata?: Record<string, unknown>;
  editedArgs?: Record<string, unknown>;
  response?: string;
}

/**
 * POST to HITLy approval ingest.
 * Returns the HITLy approval id on 2xx, or throws on error.
 */
export async function ingestHitlyApproval(
  gate: HitlyGateSettings,
  payload: HitlyIngestPayload,
  idempotencyKey: string,
): Promise<string> {
  const url = `${gate.baseUrl}/api/v1/approvals`;
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${gate.apiKey}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HITLy ingest HTTP ${res.status}: ${text || res.statusText}`);
  }

  const data = (await res.json()) as HitlyIngestResponse;
  if (!data.id) {
    throw new Error('HITLy ingest response missing id');
  }

  return data.id;
}
