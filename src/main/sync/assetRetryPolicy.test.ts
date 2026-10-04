import { describe, expect, it } from 'vitest'
import {
  ASSET_RETRY_DELAYS_MS,
  ASSET_RETRY_MAX_ATTEMPTS,
  ASSET_RETRY_UNTRUSTED_FUTURE_MS,
  isAssetRetryDue
} from './assetRetryPolicy'

const failedAt = '2026-10-04T10:00:00.000Z'
const at = (offsetMs: number): Date => new Date(Date.parse(failedAt) + offsetMs)

describe('asset retry policy', () => {
  it('is bounded: three attempts, spaced 1 and 5 minutes', () => {
    expect(ASSET_RETRY_MAX_ATTEMPTS).toBe(3)
    expect(ASSET_RETRY_DELAYS_MS).toEqual([60_000, 300_000])
  })

  it('fetches a never-tried asset at once', () => {
    expect(isAssetRetryDue(0, null, at(0))).toBe(true)
  })

  it('waits one minute after the first failure and five after the second, from the stored stamp', () => {
    expect(isAssetRetryDue(1, failedAt, at(59_999))).toBe(false)
    expect(isAssetRetryDue(1, failedAt, at(60_000))).toBe(true)
    expect(isAssetRetryDue(2, failedAt, at(299_999))).toBe(false)
    expect(isAssetRetryDue(2, failedAt, at(300_000))).toBe(true)
  })

  it('never retries after the last allowed failure, however long ago', () => {
    expect(isAssetRetryDue(3, failedAt, at(365 * 24 * 3600_000))).toBe(false)
    expect(isAssetRetryDue(7, null, at(0))).toBe(false)
  })

  it('a clock moved back keeps the asset waiting for the full delay after the stamp', () => {
    expect(isAssetRetryDue(1, failedAt, at(-3600_000))).toBe(false)
    expect(isAssetRetryDue(1, failedAt, at(-ASSET_RETRY_UNTRUSTED_FUTURE_MS))).toBe(false)
  })

  it('a stamp more than a day ahead of the clock, or unreadable, is not trusted (the attempt bound still applies)', () => {
    expect(isAssetRetryDue(1, failedAt, at(-ASSET_RETRY_UNTRUSTED_FUTURE_MS - 1))).toBe(true)
    expect(isAssetRetryDue(2, 'not a time', at(0))).toBe(true)
    expect(isAssetRetryDue(1, null, at(0))).toBe(true)
    expect(isAssetRetryDue(3, 'not a time', at(0))).toBe(false)
  })

  it('a clock moved forward only makes the try due earlier', () => {
    expect(isAssetRetryDue(2, failedAt, at(30 * 24 * 3600_000))).toBe(true)
  })
})
