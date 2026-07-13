const TASK_TIMESTAMP_SLACK_MS = 5 * 60 * 1000;
const VERIFICATION_CODE_PATTERN = /^SCPPER-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

export interface BindingTaskProofSnapshot {
  wikidotUserId: number;
  verificationCode: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface BindingCompletionProof extends BindingTaskProofSnapshot {
  revisionId: number;
  timestamp: Date;
}

export type BindingTaskStatusName = 'PENDING' | 'VERIFIED' | 'EXPIRED' | 'CANCELLED';

export interface BindingTaskStateSnapshot {
  id: string;
  createdAt: Date;
  status: BindingTaskStatusName;
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function isActionableBindingTaskStatus(status: string): boolean {
  return status === 'PENDING' || status === 'EXPIRED';
}

export function isCompletableLatestBindingTask(
  taskId: string,
  status: string,
  latestTaskId: string | null
): boolean {
  return status === 'PENDING' && taskId === latestTaskId;
}

/** Select the absolute latest task first, then decide whether it is actionable. */
export function selectLatestActionableBindingTask<T extends BindingTaskStateSnapshot>(tasks: T[]): T | null {
  const latest = tasks.reduce<T | null>((current, candidate) => {
    if (!current) return candidate;
    const timeDifference = candidate.createdAt.getTime() - current.createdAt.getTime();
    if (timeDifference > 0) return candidate;
    if (timeDifference < 0) return current;
    return candidate.id > current.id ? candidate : current;
  }, null);
  return latest && isActionableBindingTaskStatus(latest.status) ? latest : null;
}

/**
 * Bind a verifier's proof to the exact pending-task snapshot it inspected.
 *
 * The five-minute lower-bound slack matches the verifier's tolerance for clock
 * skew between Wikidot/Crom revision timestamps and PostgreSQL task creation.
 */
export function validateBindingCompletionProof(
  task: BindingTaskProofSnapshot,
  proof: BindingCompletionProof
): boolean {
  if (!Number.isSafeInteger(proof.wikidotUserId) || proof.wikidotUserId <= 0) return false;
  if (!Number.isSafeInteger(proof.revisionId) || proof.revisionId <= 0) return false;
  if (!VERIFICATION_CODE_PATTERN.test(proof.verificationCode)) return false;
  if (!isValidDate(proof.createdAt) || !isValidDate(proof.expiresAt)) return false;
  if (!isValidDate(proof.timestamp) || !isValidDate(task.createdAt) || !isValidDate(task.expiresAt)) return false;

  if (proof.wikidotUserId !== task.wikidotUserId) return false;
  if (proof.verificationCode !== task.verificationCode) return false;
  if (proof.createdAt.getTime() !== task.createdAt.getTime()) return false;
  if (proof.expiresAt.getTime() !== task.expiresAt.getTime()) return false;
  if (task.createdAt.getTime() > task.expiresAt.getTime()) return false;

  const proofTimestamp = proof.timestamp.getTime();
  const earliestAllowed = task.createdAt.getTime() - TASK_TIMESTAMP_SLACK_MS;
  return proofTimestamp >= earliestAllowed && proofTimestamp <= task.expiresAt.getTime();
}
