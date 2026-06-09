import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

/**
 * Approval workflow with Mastra HITL suspend/resume.
 * When an agent requests board approval, this workflow suspends.
 * When the board decides, the workflow resumes and enqueues an agent wake.
 */

const awaitBoardDecision = createStep({
  id: 'await-board-decision',
  inputSchema: z.object({
    approvalId: z.string(),
    agentId: z.string(),
    companyId: z.string(),
    type: z.string(),
  }),
  outputSchema: z.object({
    approved: z.boolean(),
    note: z.string().optional(),
  }),
  resumeSchema: z.object({
    approved: z.boolean(),
    note: z.string().optional(),
  }),
  suspendSchema: z.object({
    approvalId: z.string(),
    pendingSince: z.string(),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      // Suspend indefinitely until board acts via PATCH /api/approvals/:id/decide
      return await suspend({
        approvalId: inputData.approvalId,
        pendingSince: new Date().toISOString(),
      });
    }
    return { approved: resumeData.approved, note: resumeData.note };
  },
});

export const approvalWorkflow = createWorkflow({
  id: 'approval-flow',
  inputSchema: z.object({
    approvalId: z.string(),
    agentId: z.string(),
    companyId: z.string(),
    type: z.string(),
  }),
  outputSchema: z.object({ approved: z.boolean() }),
}).then(awaitBoardDecision);

approvalWorkflow.commit();
