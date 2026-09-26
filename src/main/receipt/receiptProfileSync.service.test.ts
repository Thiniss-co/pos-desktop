import { createHash } from 'node:crypto'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { CompanyReceiptProfileResource } from '../http/desktopResources.contract'
import { ReceiptProfileSyncService } from './receiptProfileSync.service'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngBuffer(extra = 'x'.repeat(10)): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(extra)])
}

function buildDependencies(
  overrides: { decodedSize?: { widthPx: number; heightPx: number } | null } = {}
): {
  repository: {
    ingest: Mock
    findPendingAssets: Mock
    markAssetAvailable: Mock
  }
  apiClient: { request: Mock }
  service: ReceiptProfileSyncService
} {
  const repository = {
    ingest: vi.fn(),
    findPendingAssets: vi.fn(() => []),
    markAssetAvailable: vi.fn(() => true)
  }
  const apiClient = { request: vi.fn() }
  const service = new ReceiptProfileSyncService({
    repository,
    apiClient,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    decodePng: () =>
      overrides.decodedSize === undefined ? { widthPx: 64, heightPx: 32 } : overrides.decodedSize
  })
  return { repository, apiClient, service }
}

const PROFILE_RESOURCE: CompanyReceiptProfileResource = {
  can_manage: true,
  profile: {
    uuid: '10000000-0000-4000-8000-000000000001',
    revision: 1,
    address_lines: ['123 Main St'],
    phone: '+1-555-0100',
    tax_identifier_label: 'VAT',
    tax_identifier_value: 'TAX-1',
    footer_lines: ['Thank you'],
    logo: null
  }
}

describe('ReceiptProfileSyncService.ingestFromBootstrap', () => {
  it('does nothing when the block is absent (not negotiated)', () => {
    const { repository, service } = buildDependencies()
    service.ingestFromBootstrap('company-1', 'user-1', undefined)
    expect(repository.ingest).not.toHaveBeenCalled()
  })

  it('ingests a present block, translating the wire shape to the repository input', () => {
    const { repository, service } = buildDependencies()
    service.ingestFromBootstrap('company-1', 'user-1', PROFILE_RESOURCE)

    expect(repository.ingest).toHaveBeenCalledWith(
      'company-1',
      'user-1',
      true,
      expect.objectContaining({
        versionUuid: PROFILE_RESOURCE.profile!.uuid,
        revision: 1,
        addressLines: ['123 Main St'],
        phone: '+1-555-0100'
      }),
      expect.any(String)
    )
  })

  it('translates a null profile to a null ingest input, never a fabricated version', () => {
    const { repository, service } = buildDependencies()
    service.ingestFromBootstrap('company-1', 'user-1', { can_manage: false, profile: null })
    expect(repository.ingest).toHaveBeenCalledWith(
      'company-1',
      'user-1',
      false,
      null,
      expect.any(String)
    )
  })

  it('swallows a repository throw rather than letting it escape (never blocks bootstrap)', () => {
    const { repository, service } = buildDependencies()
    repository.ingest.mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(() => service.ingestFromBootstrap('company-1', 'user-1', PROFILE_RESOURCE)).not.toThrow()
  })
})

describe('ReceiptProfileSyncService.fetchPendingAssets', () => {
  it('fetches, verifies and stores a valid pending asset', async () => {
    const content = pngBuffer()
    const sha256 = createHash('sha256').update(content).digest('hex')
    const { repository, apiClient, service } = buildDependencies()
    repository.findPendingAssets.mockReturnValue([{ sha256 }])
    apiClient.request.mockResolvedValue({
      sha256,
      media_type: 'image/png',
      width_px: 64,
      height_px: 32,
      byte_length: content.length,
      content_base64: content.toString('base64')
    })

    await service.fetchPendingAssets('company-1')

    expect(repository.markAssetAvailable).toHaveBeenCalledWith(
      'company-1',
      sha256,
      expect.any(Buffer),
      expect.any(String)
    )
  })

  it('leaves the asset pending when the downloaded bytes do not hash to the requested sha256', async () => {
    const content = pngBuffer()
    const claimedSha = 'a'.repeat(64) // does not match `content`'s real hash
    const { repository, apiClient, service } = buildDependencies()
    repository.findPendingAssets.mockReturnValue([{ sha256: claimedSha }])
    apiClient.request.mockResolvedValue({
      sha256: claimedSha,
      media_type: 'image/png',
      width_px: 64,
      height_px: 32,
      byte_length: content.length,
      content_base64: content.toString('base64')
    })

    await service.fetchPendingAssets('company-1')

    expect(repository.markAssetAvailable).not.toHaveBeenCalled()
  })

  it('leaves the asset pending when the response is missing the PNG signature', async () => {
    const content = Buffer.from('not-a-png-file-content')
    const sha256 = createHash('sha256').update(content).digest('hex')
    const { repository, apiClient, service } = buildDependencies()
    repository.findPendingAssets.mockReturnValue([{ sha256 }])
    apiClient.request.mockResolvedValue({
      sha256,
      media_type: 'image/png',
      width_px: 64,
      height_px: 32,
      byte_length: content.length,
      content_base64: content.toString('base64')
    })

    await service.fetchPendingAssets('company-1')

    expect(repository.markAssetAvailable).not.toHaveBeenCalled()
  })

  it('leaves the asset pending when the declared byte length does not match the actual content', async () => {
    const content = pngBuffer()
    const sha256 = createHash('sha256').update(content).digest('hex')
    const { repository, apiClient, service } = buildDependencies()
    repository.findPendingAssets.mockReturnValue([{ sha256 }])
    apiClient.request.mockResolvedValue({
      sha256,
      media_type: 'image/png',
      width_px: 64,
      height_px: 32,
      byte_length: content.length + 1,
      content_base64: content.toString('base64')
    })

    await service.fetchPendingAssets('company-1')

    expect(repository.markAssetAvailable).not.toHaveBeenCalled()
  })

  it('leaves the asset pending when the decoded dimensions exceed the receipt logo bound', async () => {
    const content = pngBuffer()
    const sha256 = createHash('sha256').update(content).digest('hex')
    const { repository, apiClient, service } = buildDependencies({
      decodedSize: { widthPx: 4000, heightPx: 4000 }
    })
    repository.findPendingAssets.mockReturnValue([{ sha256 }])
    apiClient.request.mockResolvedValue({
      sha256,
      media_type: 'image/png',
      width_px: 4000,
      height_px: 4000,
      byte_length: content.length,
      content_base64: content.toString('base64')
    })

    await service.fetchPendingAssets('company-1')

    expect(repository.markAssetAvailable).not.toHaveBeenCalled()
  })

  it('leaves the asset pending, never throws, when the HTTP request itself fails', async () => {
    const { repository, apiClient, service } = buildDependencies()
    repository.findPendingAssets.mockReturnValue([{ sha256: 'a'.repeat(64) }])
    apiClient.request.mockRejectedValue(new Error('network down'))

    await expect(service.fetchPendingAssets('company-1')).resolves.toBeUndefined()
    expect(repository.markAssetAvailable).not.toHaveBeenCalled()
  })

  it('does not start a second overlapping sweep for the same company', async () => {
    const { repository, apiClient, service } = buildDependencies()
    const holder: { resolveRequest: (() => void) | null } = { resolveRequest: null }
    repository.findPendingAssets.mockReturnValue([{ sha256: 'a'.repeat(64) }])
    apiClient.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          holder.resolveRequest = () => resolve({})
        })
    )

    const first = service.fetchPendingAssets('company-1')
    const second = service.fetchPendingAssets('company-1')

    expect(repository.findPendingAssets).toHaveBeenCalledTimes(1)
    holder.resolveRequest?.()
    await Promise.all([first, second])
  })
})

describe('ReceiptProfileSyncService.ingestPublishResponse', () => {
  it('ingests through the exact same repository call as a bootstrap block', () => {
    const { repository, service } = buildDependencies()
    service.ingestPublishResponse('company-1', 'user-1', PROFILE_RESOURCE)

    expect(repository.ingest).toHaveBeenCalledWith(
      'company-1',
      'user-1',
      true,
      expect.objectContaining({ versionUuid: PROFILE_RESOURCE.profile!.uuid }),
      expect.any(String)
    )
  })
})
