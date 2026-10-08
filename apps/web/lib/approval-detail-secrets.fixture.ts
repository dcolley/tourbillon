/**
 * Test fixture (#130 B1/B2): an approval with a distinct dummy secret planted in every field the
 * details page or JSON route renders. Used by the loader, route and page render tests. All values
 * are fake.
 */
import type { ApprovalActivityRow, ApprovalDetailRepo, ApprovalRow } from './approval-detail';

export const PLANTED = {
  payloadToken: 'plant-payload-token-0001',
  nestedApiKey: 'plant-nested-apikey-0002',
  password: 'plant-password-0003',
  secret: 'plant-secret-0004',
  resumeToken: 'plant-resume-token-0005',
  xApiKey: 'plant-x-api-key-0006',
  hitlyResume: 'plant-hitly-resume-0007',
  bearer: 'plantbearer0008abcdef',
  urlToken: 'plant-url-token-0009',
  vault: 'plant-vault-value-0010',
  provider: 'plant-provider-key-0011',
  runtime: 'plant-runtime-secret-0012',
  settings: 'plant-settings-key-0013',
  title: 'plant-title-vault-0014',
  summary: 'plantsummarybearer0015',
  note: 'plant-note-url-0016',
  hitlyError: 'plant-hitly-err-0017',
  issueTitle: 'plant-issue-provider-0018',
  historyNote: 'plant-history-note-0019',
  actorName: 'plant-actor-0020',
  nestedCookie: 'plant-cookie-0021',
} as const;

export const PLANTED_VALUES: string[] = Object.values(PLANTED);

const T = (hhmm: string) => new Date(`2026-10-08T${hhmm}:00.000Z`);

export function plantedApproval(over: Partial<ApprovalRow> = {}): ApprovalRow {
  const p = PLANTED;
  return {
    id: 'appr-a',
    companyId: 'company-a',
    type: 'request_board_approval',
    status: 'rejected',
    requestedByAgentId: 'agent-a',
    decidedByUserId: null,
    issueIds: ['issue-a1'],
    payload: {
      title: `Deploy with ${p.title}`,
      summary: `Call it with Authorization: Bearer ${p.summary}`,
      token: p.payloadToken,
      list: [{ apiKey: p.nestedApiKey }, { deeper: [{ Cookie: `sid=${p.nestedCookie}` }] }],
      auth: { password: p.password, nested: { secret: p.secret } },
      resumeToken: p.resumeToken,
      hitlyResumeToken: p.hitlyResume,
      headers: { 'x-api-key': p.xApiKey, Authorization: `Bearer ${p.bearer}` },
      callback: `https://hooks.example.test/resume?token=${p.urlToken}`,
      notes: `vault ${p.vault}, provider ${p.provider}, runtime ${p.runtime}, settings ${p.settings}`,
      priorStatuses: { 'issue-a1': 'todo' },
    },
    note: `Rejected: see https://ci.example.test/run?token=${p.note}`,
    decidedAt: T('10:30'),
    hitlyApprovalId: 'hitly-1',
    hitlyError: `401 for resume token ${p.hitlyResume} (apiKey=${p.hitlyError})`,
    createdAt: T('09:00'),
    updatedAt: T('10:30'),
    ...over,
  };
}

export function plantedActivity(): ApprovalActivityRow[] {
  const p = PLANTED;
  return [
    {
      id: 'l1', companyId: 'company-a', actorType: 'agent', actorId: 'agent-a', actorName: null,
      action: 'issue.updated', entityType: 'issue', entityId: 'issue-a1',
      details: { boardApprovalId: 'appr-a', status: 'blocked', priorStatus: 'todo' }, createdAt: T('09:01'),
    },
    {
      id: 'l2', companyId: 'company-a', actorType: 'user', actorId: 'board', actorName: `Board via ${p.actorName}`,
      action: 'approval.commented', entityType: 'approval', entityId: 'appr-a',
      details: { note: `password was ${p.password}; vault ${p.historyNote}` }, createdAt: T('09:30'),
    },
  ];
}

/** Repo serving the planted approval for company-a (company-scoped like the real one). */
export function plantedRepo(over: Partial<ApprovalRow> = {}): ApprovalDetailRepo {
  const p = PLANTED;
  const approval = plantedApproval(over);
  return {
    async getApproval(companyId, id) {
      return companyId === approval.companyId && id === approval.id ? approval : null;
    },
    async getAgent(companyId, id) {
      return companyId === 'company-a' && id === 'agent-a'
        ? { id, companyId, name: 'Alice', urlKey: 'alice', runtimeConfig: { secrets: { GH_TOKEN: p.runtime } } }
        : null;
    },
    async getIssues(companyId, ids) {
      return companyId === 'company-a' && ids.includes('issue-a1')
        ? [{ id: 'issue-a1', companyId, identifier: 'TOUR-1', title: `Rotate ${p.issueTitle}`, status: 'todo', boardApprovalId: null }]
        : [];
    },
    async getActivity() {
      return plantedActivity();
    },
    async getCompanySettings() {
      return { hitlyGate: { apiKey: p.settings }, mcpCredentials: { github: p.actorName } };
    },
    async getSecretValues() {
      return { values: [p.vault, p.title, p.historyNote, p.provider, p.issueTitle], vaultUnavailable: false };
    },
  };
}
