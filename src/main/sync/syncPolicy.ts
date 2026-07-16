import { canProcessSyncQueueItem, type SyncQueueState } from '@shared/constants/syncQueueStates'

export type IdempotencyReplayDecision = 'duplicate_replay' | 'conflict'

export function calculateRetryDelayMs(
  attemptCount: number,
  random: () => number = Math.random,
  baseDelayMs = 1_000,
  maximumDelayMs = 300_000
): number {
  const exponentialDelay = Math.min(baseDelayMs * 2 ** Math.max(attemptCount, 0), maximumDelayMs)
  return Math.round(exponentialDelay * (0.5 + random()))
}

export function decideIdempotencyReplay(
  queuedPayloadHash: string,
  replayedPayloadHash: string
): IdempotencyReplayDecision {
  return queuedPayloadHash === replayedPayloadHash ? 'duplicate_replay' : 'conflict'
}

export function isUploadLeaseExpired(
  leaseClaimedAt: string | null,
  now: Date,
  leaseDurationMs = 60_000
): boolean {
  if (!leaseClaimedAt) {
    return true
  }

  const leaseStartedAt = Date.parse(leaseClaimedAt)
  return Number.isNaN(leaseStartedAt) || now.getTime() - leaseStartedAt >= leaseDurationMs
}

export function canUploadQueueItem(
  state: SyncQueueState,
  dependencyState?: SyncQueueState
): boolean {
  return canProcessSyncQueueItem(state, dependencyState ? { state: dependencyState } : undefined)
}
