'use client';

import { JobLogPanel } from '../../jobs/[queue]/[jobId]/job-log-panel';

interface IssueExecutionPanelProps {
  queue: string;
  jobId: string;
  jobState: string;
}

export function IssueExecutionPanel({ queue, jobId, jobState }: IssueExecutionPanelProps) {
  return (
    <JobLogPanel
      queue={queue}
      jobId={jobId}
      initialState={jobState}
    />
  );
}
