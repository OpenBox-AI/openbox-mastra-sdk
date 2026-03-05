export interface PendingApprovalEntry {
  activityId: string;
  activityType: string;
  approvalId?: string | undefined;
  requestedAt: string;
  runId: string;
  workflowId: string;
  workflowType: string;
}

const pendingApprovals = new Map<string, PendingApprovalEntry>();

export function getPendingApproval(runId: string): PendingApprovalEntry | undefined {
  return pendingApprovals.get(runId);
}

export function setPendingApproval(entry: PendingApprovalEntry): void {
  pendingApprovals.set(entry.runId, entry);
}

export function clearPendingApproval(runId: string): void {
  pendingApprovals.delete(runId);
}
