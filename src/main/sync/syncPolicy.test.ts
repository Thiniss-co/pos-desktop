import { describe, expect, it } from 'vitest'
import {
  calculateRetryDelayMs,
  canUploadQueueItem,
  decideIdempotencyReplay,
  isUploadLeaseExpired
} from './syncPolicy'

describe('sync policy helpers', () => {
  it('calculates bounded backoff with injected jitter', () => {
    expect(calculateRetryDelayMs(2, () => 0.5, 1_000, 10_000)).toBe(4_000)
  })

  it('distinguishes idempotent replays from payload conflicts', () => {
    expect(decideIdempotencyReplay('same-hash', 'same-hash')).toBe('duplicate_replay')
    expect(decideIdempotencyReplay('first-hash', 'second-hash')).toBe('conflict')
  })

  it('recovers expired upload leases and respects dependency ordering', () => {
    expect(
      isUploadLeaseExpired('2026-01-01T00:00:00.000Z', new Date('2026-01-01T00:02:00.000Z'))
    ).toBe(true)
    expect(canUploadQueueItem('pending', 'synced')).toBe(true)
    expect(canUploadQueueItem('pending', 'uploading')).toBe(false)
  })
})
