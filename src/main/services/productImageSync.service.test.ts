import { createHash } from 'node:crypto'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { createPublicError } from '../http/apiError'
import type { ProductImageAssetResponse } from '../http/desktopResources.contract'
import type { PendingProductImageAsset } from '../repositories/productImage.repository'
import {
  MAX_BYTES_PER_SWEEP,
  MAX_ASSETS_PER_SWEEP,
  ProductImageSyncService,
  readWebpDimensions,
  verifyProductImageAssetBytes
} from './productImageSync.service'

/** 160×120 WebPs written by the backend's encoder (GD): lossy (`VP8 `) and lossless (`VP8L`). */
const LOSSY = Buffer.from(
  'UklGRnIAAABXRUJQVlA4IGYAAADQBwCdASqgAHgAPm02mUmkIyKhIGgAgA2JaW7hdUlwH4AAAO6HVUmyYh1VJsmIdVSbJiHVUmyYh1VJsmIdVSbJiHVUmyYWAAD+/o4z//84ljqd3pB//87B7Lv3qylDoR2EAAAAAAA=',
  'base64'
)
const LOSSLESS = Buffer.from(
  'UklGRiQAAABXRUJQVlA4TBcAAAAvn8AdAAdQvFIUuf8BAEX6/18i+p96BQA=',
  'base64'
)
const COMPANY = '00000000-0000-4000-8000-000000000001'
const TOKEN = `${COMPANY}|device|user|1`

const sha = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex')
const pending = (content: Buffer): PendingProductImageAsset => ({
  sha256: sha(content),
  byteLength: content.length,
  widthPx: 160,
  heightPx: 120
})
const answer = (
  content: Buffer,
  overrides: Record<string, unknown> = {}
): ProductImageAssetResponse => ({
  sha256: sha(content),
  media_type: 'image/webp' as const,
  width_px: 160,
  height_px: 120,
  byte_length: content.length,
  content_base64: content.toString('base64'),
  ...overrides
})

describe('product image bytes', () => {
  it('reads the canvas size from lossy and lossless WebP bitstreams', () => {
    expect(readWebpDimensions(LOSSY)).toEqual({ widthPx: 160, heightPx: 120 })
    expect(readWebpDimensions(LOSSLESS)).toEqual({ widthPx: 160, heightPx: 120 })
    expect(readWebpDimensions(Buffer.from('not an image at all, but long enough'))).toBeNull()
  })

  it('trusts bytes only when hash, length, signature and size all agree with the declaration', () => {
    const expected = pending(LOSSY)
    expect(
      verifyProductImageAssetBytes(expected, answer(LOSSY), readWebpDimensions)?.equals(LOSSY)
    ).toBe(true)
    expect(
      verifyProductImageAssetBytes(expected, answer(LOSSY, { width_px: 161 }), readWebpDimensions)
    ).toBeNull()
    expect(
      verifyProductImageAssetBytes(
        expected,
        answer(LOSSY, { byte_length: LOSSY.length + 1 }),
        readWebpDimensions
      )
    ).toBeNull()
    expect(
      verifyProductImageAssetBytes(
        expected,
        answer(LOSSLESS, { sha256: expected.sha256 }),
        readWebpDimensions
      )
    ).toBeNull()
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), LOSSY.subarray(4)])
    expect(verifyProductImageAssetBytes(pending(png), answer(png), readWebpDimensions)).toBeNull()
  })
})

function worker(options: {
  responses: Record<string, unknown | Error>
  assets: PendingProductImageAsset[]
  contextKey?: () => string | null
}): {
  service: ProductImageSyncService
  repository: { findPendingAssets: Mock; markAvailable: Mock; markFailed: Mock }
  apiClient: { request: Mock }
} {
  const repository = {
    findPendingAssets: vi.fn(() => options.assets),
    markAvailable: vi.fn(() => true),
    markFailed: vi.fn()
  }
  const apiClient = {
    request: vi.fn(
      async (
        route: { path: string },
        _body?: unknown,
        requestOptions?: { reportOutcome?: boolean }
      ) => {
        expect(requestOptions).toEqual({ reportOutcome: false })
        const response = options.responses[route.path.split('/').pop() as string]
        if (response instanceof Error) throw response
        return response
      }
    )
  }
  const service = new ProductImageSyncService({
    repository,
    apiClient: apiClient as never,
    contextKey: options.contextKey ?? (() => TOKEN),
    now: () => new Date('2026-10-04T10:00:00Z')
  })

  return { service, repository, apiClient }
}

describe('product image worker', () => {
  it('asks the repository for assets due at its own clock (the retry delay is decided there)', async () => {
    const { service, repository } = worker({ assets: [], responses: {} })

    await service.sweep(COMPANY)
    expect(repository.findPendingAssets).toHaveBeenCalledWith(
      COMPANY,
      MAX_ASSETS_PER_SWEEP,
      new Date('2026-10-04T10:00:00Z')
    )
  })

  it('stores verified bytes and records failures for later bootstraps, without reporting connectivity', async () => {
    const bad = Buffer.concat([LOSSLESS])
    const { service, repository } = worker({
      assets: [pending(LOSSY), { ...pending(bad), widthPx: 999 }],
      responses: { [sha(LOSSY)]: answer(LOSSY), [sha(bad)]: answer(bad) }
    })

    await service.sweep(COMPANY)

    expect(repository.markAvailable).toHaveBeenCalledWith(
      COMPANY,
      sha(LOSSY),
      LOSSY,
      '2026-10-04T10:00:00.000Z'
    )
    expect(repository.markFailed).toHaveBeenCalledWith(
      COMPANY,
      sha(bad),
      '2026-10-04T10:00:00.000Z'
    )
  })

  it('stops the sweep on an access refusal, and discards results when the owner changed meanwhile', async () => {
    const refused = worker({
      assets: [pending(LOSSY), pending(LOSSLESS)],
      responses: { [sha(LOSSY)]: answer(LOSSY), [sha(LOSSLESS)]: answer(LOSSLESS) }
    })
    refused.apiClient.request.mockImplementationOnce(async () => {
      throw createPublicError('authentication', 'Revoked.', false, {
        backendCode: 'UNAUTHENTICATED'
      })
    })
    await refused.service.sweep(COMPANY)
    expect(refused.apiClient.request).toHaveBeenCalledTimes(1)
    expect(refused.repository.markFailed).not.toHaveBeenCalled()

    let owner: string | null = TOKEN
    const changed = worker({
      assets: [pending(LOSSY), pending(LOSSLESS)],
      responses: { [sha(LOSSY)]: answer(LOSSY), [sha(LOSSLESS)]: answer(LOSSLESS) },
      contextKey: () => owner
    })
    changed.apiClient.request.mockImplementationOnce(async () => {
      owner = `${COMPANY}|device|another-user|2`
      return answer(LOSSY)
    })
    await changed.service.sweep(COMPANY)
    expect(changed.repository.markAvailable).not.toHaveBeenCalled()
    expect(changed.apiClient.request).toHaveBeenCalledTimes(1)
  })

  it('sweeps only the signed-in company, never after stop(), and within the byte budget', async () => {
    const other = worker({ assets: [pending(LOSSY)], responses: { [sha(LOSSY)]: answer(LOSSY) } })
    await other.service.sweep('00000000-0000-4000-8000-000000000002')
    expect(other.apiClient.request).not.toHaveBeenCalled()

    other.service.stop()
    await other.service.sweep(COMPANY)
    expect(other.apiClient.request).not.toHaveBeenCalled()

    const big = worker({
      assets: [{ ...pending(LOSSY), byteLength: MAX_BYTES_PER_SWEEP }, pending(LOSSLESS)],
      responses: {}
    })
    await big.service.sweep(COMPANY)
    expect(big.apiClient.request).toHaveBeenCalledTimes(1)
  })

  it("a sweep requested while one runs is queued once, so a newer bootstrap's images are not left pending", async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { service, repository, apiClient } = worker({
      assets: [pending(LOSSY)],
      responses: { [sha(LOSSY)]: answer(LOSSY) }
    })
    apiClient.request.mockImplementationOnce(async () => {
      await gate
      return answer(LOSSY)
    })

    const first = service.sweep(COMPANY)
    await service.sweep(COMPANY)
    await service.sweep(COMPANY)
    release()
    await first
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(repository.findPendingAssets).toHaveBeenCalledTimes(2)
  })
})
