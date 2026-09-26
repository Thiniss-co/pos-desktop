import { createHash } from 'node:crypto'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { ReceiptProfileVersionRow } from '../repositories/receiptProfile.repository'
import type { ReceiptOwner } from './receiptAccess.service'
import { ReceiptProfileAdminService } from './receiptProfileAdmin.service'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngBuffer(extra = 'x'.repeat(10)): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(extra)])
}

const OWNER: ReceiptOwner = {
  companyUuid: 'company-1',
  deviceUuid: 'device-1',
  userUuid: 'user-1',
  sessionEpoch: 1
}

const VERSION_UUID = '10000000-0000-4000-8000-000000000001'

function versionRow(overrides: Partial<ReceiptProfileVersionRow> = {}): ReceiptProfileVersionRow {
  return {
    versionUuid: VERSION_UUID,
    companyUuid: OWNER.companyUuid,
    revision: 1,
    addressLines: ['123 Main St'],
    phone: '+1-555-0100',
    taxIdentifierLabel: 'VAT',
    taxIdentifierValue: 'TAX-1',
    footerLines: ['Thank you'],
    logoSha256: null,
    logoAvailable: false,
    receivedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function buildDependencies(
  overrides: {
    canManage?: boolean
    online?: boolean
    current?: { versionUuid: string | null; capability: 'unsupported' | 'supported' } | null
    version?: ReceiptProfileVersionRow | null
  } = {}
): {
  repository: {
    getCurrent: Mock
    getVersion: Mock
    getAuthority: Mock
    getAsset: Mock
    recordUploadedAsset: Mock
  }
  sync: { ingestPublishResponse: Mock }
  apiClient: { request: Mock }
  connectivity: { getSnapshot: Mock }
  dialog: { showOpenDialog: Mock }
  readFile: Mock
  refreshBootstrap: Mock
  service: ReceiptProfileAdminService
} {
  const repository = {
    getCurrent: vi.fn(() =>
      overrides.current !== undefined
        ? overrides.current
        : { versionUuid: VERSION_UUID, capability: 'supported' as const }
    ),
    getVersion: vi.fn(() => (overrides.version === undefined ? versionRow() : overrides.version)),
    getAuthority: vi.fn(() => overrides.canManage ?? true),
    getAsset: vi.fn(() => null),
    recordUploadedAsset: vi.fn()
  }
  const sync = { ingestPublishResponse: vi.fn() }
  const apiClient = { request: vi.fn() }
  const connectivity = {
    getSnapshot: vi.fn(() => ({ status: overrides.online === false ? 'offline' : 'online' }))
  }
  const dialog = { showOpenDialog: vi.fn() }
  const readFile = vi.fn()
  const refreshBootstrap = vi.fn().mockResolvedValue(undefined)

  const service = new ReceiptProfileAdminService({
    repository,
    sync,
    apiClient,
    connectivity: connectivity as never,
    dialog: dialog as never,
    readFile,
    refreshBootstrap,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    decodePng: () => ({ widthPx: 64, heightPx: 32 })
  })

  return { repository, sync, apiClient, connectivity, dialog, readFile, refreshBootstrap, service }
}

describe('ReceiptProfileAdminService.get', () => {
  it('reports unsupported and hides management when the mirror was never bootstrapped', () => {
    const { service } = buildDependencies({ current: null })
    expect(service.get(OWNER)).toEqual({
      capability: 'unsupported',
      canManage: false,
      profile: null,
      logo: null
    })
  })

  it('reports supported with no profile when the company has never published one', () => {
    const { service } = buildDependencies({
      current: { versionUuid: null, capability: 'supported' }
    })
    const result = service.get(OWNER)
    expect(result.capability).toBe('supported')
    expect(result.profile).toBeNull()
  })

  it('reads canManage from the local authority mirror, fail-closed for an unknown pair', () => {
    const { service, repository } = buildDependencies({ canManage: false })
    const result = service.get(OWNER)
    expect(result.canManage).toBe(false)
    expect(repository.getAuthority).toHaveBeenCalledWith(OWNER.companyUuid, OWNER.userUuid)
  })

  it('returns the captured version fields with no logo when none was published', () => {
    const { service } = buildDependencies()
    const result = service.get(OWNER)
    expect(result.profile).toMatchObject({ versionUuid: VERSION_UUID, revision: 1 })
    expect(result.logo).toBeNull()
  })

  it('reports the logo as present-but-not-yet-downloaded while the asset is still pending', () => {
    const { service } = buildDependencies({
      version: versionRow({ logoSha256: 'a'.repeat(64), logoAvailable: false })
    })
    const result = service.get(OWNER)
    expect(result.logo).toEqual({ present: true, thumbnailPngDataUrl: null })
    expect(result.profile?.logo).toBeNull()
  })

  it('returns a thumbnail data URL once the logo asset is available', () => {
    const sha256 = 'a'.repeat(64)
    const { service, repository } = buildDependencies({
      version: versionRow({ logoSha256: sha256, logoAvailable: true })
    })
    repository.getAsset.mockReturnValue({
      companyUuid: OWNER.companyUuid,
      sha256,
      mediaType: 'image/png',
      widthPx: 64,
      heightPx: 32,
      byteLength: 18,
      content: pngBuffer(),
      status: 'available'
    })

    const result = service.get(OWNER)
    expect(result.logo?.present).toBe(true)
    expect(result.logo?.thumbnailPngDataUrl).toMatch(/^data:image\/png;base64,/)
    expect(result.profile?.logo).toMatchObject({ sha256 })
  })
})

describe('ReceiptProfileAdminService.chooseLogo', () => {
  it('refuses a non-CompanyAdmin caller before ever opening the file dialog', async () => {
    const { service, dialog } = buildDependencies({ canManage: false })
    await expect(service.chooseLogo(OWNER)).rejects.toMatchObject({ category: 'authorization' })
    expect(dialog.showOpenDialog).not.toHaveBeenCalled()
  })

  it('refuses while offline before ever opening the file dialog', async () => {
    const { service, dialog } = buildDependencies({ online: false })
    await expect(service.chooseLogo(OWNER)).rejects.toMatchObject({
      backendCode: 'RECEIPT_PROFILE_UNAVAILABLE_OFFLINE'
    })
    expect(dialog.showOpenDialog).not.toHaveBeenCalled()
  })

  it('rejects when the dialog is cancelled', async () => {
    const { service, dialog } = buildDependencies()
    dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await expect(service.chooseLogo(OWNER)).rejects.toMatchObject({ category: 'validation' })
  })

  it('rejects a file over the 1 MiB bound without ever uploading it', async () => {
    const { service, dialog, readFile, apiClient } = buildDependencies()
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/logo.png'] })
    readFile.mockResolvedValue(Buffer.alloc(1024 * 1024 + 1))

    await expect(service.chooseLogo(OWNER)).rejects.toMatchObject({
      backendCode: 'RECEIPT_PROFILE_ASSET_INVALID'
    })
    expect(apiClient.request).not.toHaveBeenCalled()
  })

  it('uploads, downloads the processed asset, verifies it, and records it as available', async () => {
    const { service, dialog, readFile, apiClient, repository } = buildDependencies()
    const content = pngBuffer()
    const sha256 = createHash('sha256').update(content).digest('hex')
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/logo.png'] })
    readFile.mockResolvedValue(Buffer.from('original upload bytes'))
    apiClient.request
      .mockResolvedValueOnce({
        sha256,
        media_type: 'image/png',
        width_px: 64,
        height_px: 32,
        byte_length: content.length
      })
      .mockResolvedValueOnce({
        sha256,
        media_type: 'image/png',
        width_px: 64,
        height_px: 32,
        byte_length: content.length,
        content_base64: content.toString('base64')
      })

    const result = await service.chooseLogo(OWNER)

    expect(result.sha256).toBe(sha256)
    expect(result.thumbnailPngDataUrl).toMatch(/^data:image\/png;base64,/)
    expect(repository.recordUploadedAsset).toHaveBeenCalledWith(
      OWNER.companyUuid,
      sha256,
      'image/png',
      64,
      32,
      content.length,
      expect.any(Buffer),
      expect.any(String)
    )
  })

  it('rejects when the downloaded processed asset fails verification', async () => {
    const { service, dialog, readFile, apiClient, repository } = buildDependencies()
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/logo.png'] })
    readFile.mockResolvedValue(Buffer.from('original upload bytes'))
    const claimedSha = 'a'.repeat(64)
    apiClient.request
      .mockResolvedValueOnce({
        sha256: claimedSha,
        media_type: 'image/png',
        width_px: 64,
        height_px: 32,
        byte_length: 999
      })
      .mockResolvedValueOnce({
        sha256: claimedSha,
        media_type: 'image/png',
        width_px: 64,
        height_px: 32,
        byte_length: 999,
        content_base64: Buffer.from('not-actually-that-hash').toString('base64')
      })

    await expect(service.chooseLogo(OWNER)).rejects.toMatchObject({
      backendCode: 'RECEIPT_PROFILE_ASSET_INVALID'
    })
    expect(repository.recordUploadedAsset).not.toHaveBeenCalled()
  })
})

describe('ReceiptProfileAdminService.publish', () => {
  it('refuses a non-CompanyAdmin caller before ever calling the backend', async () => {
    const { service, apiClient } = buildDependencies({ canManage: false })
    await expect(
      service.publish(OWNER, {
        expectedRevision: 1,
        fields: {
          addressLines: [],
          phone: null,
          taxIdentifierLabel: null,
          taxIdentifierValue: null,
          footerLines: []
        },
        logo: { action: 'keep' }
      })
    ).rejects.toMatchObject({ category: 'authorization' })
    expect(apiClient.request).not.toHaveBeenCalled()
  })

  it('refuses while offline before ever calling the backend', async () => {
    const { service, apiClient } = buildDependencies({ online: false })
    await expect(
      service.publish(OWNER, {
        expectedRevision: 1,
        fields: {
          addressLines: [],
          phone: null,
          taxIdentifierLabel: null,
          taxIdentifierValue: null,
          footerLines: []
        },
        logo: { action: 'remove' }
      })
    ).rejects.toMatchObject({ backendCode: 'RECEIPT_PROFILE_UNAVAILABLE_OFFLINE' })
    expect(apiClient.request).not.toHaveBeenCalled()
  })

  it('resolves a "keep" logo action to the current version\'s own sha256, never a server-side keep', async () => {
    const { service, apiClient } = buildDependencies({
      version: versionRow({ logoSha256: 'b'.repeat(64), logoAvailable: true })
    })
    apiClient.request.mockResolvedValue({
      can_manage: true,
      profile: {
        uuid: '20000000-0000-4000-8000-000000000002',
        revision: 2,
        address_lines: [],
        phone: null,
        tax_identifier_label: null,
        tax_identifier_value: null,
        footer_lines: [],
        logo: null
      }
    })

    await service.publish(OWNER, {
      expectedRevision: 1,
      fields: {
        addressLines: [],
        phone: null,
        taxIdentifierLabel: null,
        taxIdentifierValue: null,
        footerLines: []
      },
      logo: { action: 'keep' }
    })

    expect(apiClient.request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ logo_sha256: 'b'.repeat(64) })
    )
  })

  it('resolves a "remove" logo action to a null sha', async () => {
    const { service, apiClient } = buildDependencies({
      version: versionRow({ logoSha256: 'b'.repeat(64), logoAvailable: true })
    })
    apiClient.request.mockResolvedValue({
      can_manage: true,
      profile: {
        uuid: '20000000-0000-4000-8000-000000000002',
        revision: 2,
        address_lines: [],
        phone: null,
        tax_identifier_label: null,
        tax_identifier_value: null,
        footer_lines: [],
        logo: null
      }
    })

    await service.publish(OWNER, {
      expectedRevision: 1,
      fields: {
        addressLines: [],
        phone: null,
        taxIdentifierLabel: null,
        taxIdentifierValue: null,
        footerLines: []
      },
      logo: { action: 'remove' }
    })

    expect(apiClient.request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ logo_sha256: null })
    )
  })

  it('rejects a "set" action naming a sha the caller never uploaded and that is not already current', async () => {
    const { service, apiClient } = buildDependencies()
    await expect(
      service.publish(OWNER, {
        expectedRevision: 1,
        fields: {
          addressLines: [],
          phone: null,
          taxIdentifierLabel: null,
          taxIdentifierValue: null,
          footerLines: []
        },
        logo: { action: 'set', sha256: 'c'.repeat(64) }
      })
    ).rejects.toMatchObject({ category: 'validation' })
    expect(apiClient.request).not.toHaveBeenCalled()
  })

  it('accepts a "set" action naming a sha this session uploaded via chooseLogo', async () => {
    const sha256 = createHash('sha256').update(pngBuffer()).digest('hex')
    const { service, apiClient, dialog, readFile } = buildDependencies()
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/logo.png'] })
    readFile.mockResolvedValue(Buffer.from('original upload bytes'))
    const content = pngBuffer()
    apiClient.request
      .mockResolvedValueOnce({
        sha256,
        media_type: 'image/png',
        width_px: 64,
        height_px: 32,
        byte_length: content.length
      })
      .mockResolvedValueOnce({
        sha256,
        media_type: 'image/png',
        width_px: 64,
        height_px: 32,
        byte_length: content.length,
        content_base64: content.toString('base64')
      })
    await service.chooseLogo(OWNER)

    apiClient.request.mockResolvedValueOnce({
      can_manage: true,
      profile: {
        uuid: '20000000-0000-4000-8000-000000000002',
        revision: 2,
        address_lines: [],
        phone: null,
        tax_identifier_label: null,
        tax_identifier_value: null,
        footer_lines: [],
        logo: null
      }
    })

    await expect(
      service.publish(OWNER, {
        expectedRevision: 1,
        fields: {
          addressLines: [],
          phone: null,
          taxIdentifierLabel: null,
          taxIdentifierValue: null,
          footerLines: []
        },
        logo: { action: 'set', sha256 }
      })
    ).resolves.toBeDefined()
  })

  it('ingests a successful publish response through the shared monotonic protocol', async () => {
    const { service, apiClient, sync } = buildDependencies()
    apiClient.request.mockResolvedValue({
      can_manage: true,
      profile: {
        uuid: '20000000-0000-4000-8000-000000000002',
        revision: 2,
        address_lines: ['New address'],
        phone: null,
        tax_identifier_label: null,
        tax_identifier_value: null,
        footer_lines: [],
        logo: null
      }
    })

    await service.publish(OWNER, {
      expectedRevision: 1,
      fields: {
        addressLines: ['New address'],
        phone: null,
        taxIdentifierLabel: null,
        taxIdentifierValue: null,
        footerLines: []
      },
      logo: { action: 'remove' }
    })

    expect(sync.ingestPublishResponse).toHaveBeenCalledWith(
      OWNER.companyUuid,
      OWNER.userUuid,
      expect.objectContaining({
        can_manage: true,
        profile: expect.objectContaining({ revision: 2 })
      })
    )
  })

  it('on a 409 revision conflict, best-effort refreshes bootstrap and still rejects with that code', async () => {
    const { service, apiClient, refreshBootstrap } = buildDependencies()
    apiClient.request.mockRejectedValue({
      category: 'conflict',
      message: 'stale',
      backendCode: 'RECEIPT_PROFILE_REVISION_CONFLICT',
      retryable: false
    })

    await expect(
      service.publish(OWNER, {
        expectedRevision: 1,
        fields: {
          addressLines: [],
          phone: null,
          taxIdentifierLabel: null,
          taxIdentifierValue: null,
          footerLines: []
        },
        logo: { action: 'remove' }
      })
    ).rejects.toMatchObject({ backendCode: 'RECEIPT_PROFILE_REVISION_CONFLICT' })

    expect(refreshBootstrap).toHaveBeenCalledTimes(1)
  })

  it('never calls refreshBootstrap for an unrelated failure', async () => {
    const { service, apiClient, refreshBootstrap } = buildDependencies()
    apiClient.request.mockRejectedValue({
      category: 'transport',
      message: 'network down',
      retryable: true
    })

    await expect(
      service.publish(OWNER, {
        expectedRevision: 1,
        fields: {
          addressLines: [],
          phone: null,
          taxIdentifierLabel: null,
          taxIdentifierValue: null,
          footerLines: []
        },
        logo: { action: 'remove' }
      })
    ).rejects.toMatchObject({ category: 'transport' })

    expect(refreshBootstrap).not.toHaveBeenCalled()
  })
})
