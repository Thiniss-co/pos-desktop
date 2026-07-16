import { describe, expect, it } from 'vitest'
import {
  canProcessSyncQueueItem,
  hasImmutableSyncQueueFieldsChanged,
  isSyncQueueTransitionAllowed
} from './syncQueueStates'

describe('sync queue policy', () => {
  it('allows only defined queue state transitions', () => {
    expect(isSyncQueueTransitionAllowed('pending', 'uploading')).toBe(true)
    expect(isSyncQueueTransitionAllowed('uploading', 'synced')).toBe(true)
    expect(isSyncQueueTransitionAllowed('conflict', 'pending')).toBe(false)
  })

  it('holds dependent items until their dependency is synced', () => {
    expect(canProcessSyncQueueItem('pending', { state: 'pending' })).toBe(false)
    expect(canProcessSyncQueueItem('pending', { state: 'synced' })).toBe(true)
  })

  it('detects changes to immutable enqueue fields', () => {
    const queueRecord = {
      payloadJson: '{"sale":"local-1"}',
      payloadHash: 'hash-1',
      idempotencyKey: 'key-1'
    }

    expect(hasImmutableSyncQueueFieldsChanged(queueRecord, queueRecord)).toBe(false)
    expect(
      hasImmutableSyncQueueFieldsChanged(queueRecord, {
        ...queueRecord,
        idempotencyKey: 'key-2'
      })
    ).toBe(true)
  })
})
