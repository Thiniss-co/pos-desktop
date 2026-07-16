export const SYNC_QUEUE_STATES = [
  'pending',
  'uploading',
  'synced',
  'retryable_error',
  'conflict',
  'rejected'
] as const

export type SyncQueueState = (typeof SYNC_QUEUE_STATES)[number]

const syncQueueTransitions = {
  pending: ['uploading'],
  uploading: ['synced', 'retryable_error', 'conflict', 'rejected'],
  synced: [],
  retryable_error: ['pending'],
  conflict: [],
  rejected: []
} satisfies Record<SyncQueueState, readonly SyncQueueState[]>

export const SYNC_QUEUE_TRANSITIONS: Readonly<Record<SyncQueueState, readonly SyncQueueState[]>> =
  Object.freeze(syncQueueTransitions)

export interface SyncQueueDependency {
  readonly state: SyncQueueState
}

export interface ImmutableSyncQueueRecord {
  readonly payloadJson: string
  readonly payloadHash: string
  readonly idempotencyKey: string
}

export function isSyncQueueState(value: string): value is SyncQueueState {
  return (SYNC_QUEUE_STATES as readonly string[]).includes(value)
}

export function isSyncQueueTransitionAllowed(from: SyncQueueState, to: SyncQueueState): boolean {
  return SYNC_QUEUE_TRANSITIONS[from].includes(to)
}

export function canProcessSyncQueueItem(
  state: SyncQueueState,
  dependency?: SyncQueueDependency
): boolean {
  return state === 'pending' && (!dependency || dependency.state === 'synced')
}

export function hasImmutableSyncQueueFieldsChanged(
  existing: ImmutableSyncQueueRecord,
  candidate: ImmutableSyncQueueRecord
): boolean {
  return (
    existing.payloadJson !== candidate.payloadJson ||
    existing.payloadHash !== candidate.payloadHash ||
    existing.idempotencyKey !== candidate.idempotencyKey
  )
}
