import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { CompanyBrandSyncService, verifyCompanyLogoBytes } from './companyBrandSync.service'

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40, 3)
])
const SHA = createHash('sha256').update(PNG).digest('hex')
const COMPANY = '00000000-0000-4000-8000-000000000001'
const pending = { sha256: SHA, byteLength: PNG.length, widthPx: 200, heightPx: 80 }
const answer = {
  sha256: SHA,
  media_type: 'image/png' as const,
  width_px: 200,
  height_px: 80,
  byte_length: PNG.length,
  content_base64: PNG.toString('base64')
}
const decode = (): { widthPx: number; heightPx: number } => ({ widthPx: 200, heightPx: 80 })

describe('company logo worker (P9)', () => {
  it('trusts the bytes only when hash, signature, length and decoded size agree', () => {
    expect(verifyCompanyLogoBytes(pending, answer, decode)?.equals(PNG)).toBe(true)
    expect(
      verifyCompanyLogoBytes(pending, answer, () => ({ widthPx: 199, heightPx: 80 }))
    ).toBeNull()
    expect(verifyCompanyLogoBytes({ ...pending, byteLength: 1 }, answer, decode)).toBeNull()
    const webp = Buffer.concat([Buffer.from('RIFF'), PNG.subarray(4)])
    expect(
      verifyCompanyLogoBytes(
        pending,
        { ...answer, content_base64: webp.toString('base64') },
        decode
      )
    ).toBeNull()
  })

  it('stores a verified logo and notifies once; discards it when the owner changed during the request', async () => {
    const repository = {
      findPendingLogo: vi.fn(() => pending),
      markAvailable: vi.fn(() => true),
      markFailed: vi.fn()
    }
    const onStored = vi.fn()
    let owner: string | null = `${COMPANY}|d|u|1`
    const apiClient = { request: vi.fn(async () => answer) }
    const service = new CompanyBrandSyncService({
      repository,
      apiClient: apiClient as never,
      contextKey: () => owner,
      decodePng: decode,
      onStored
    })

    await service.sweep(COMPANY)
    expect(repository.markAvailable).toHaveBeenCalledTimes(1)
    expect(onStored).toHaveBeenCalledTimes(1)
    expect(apiClient.request).toHaveBeenCalledWith(expect.anything(), undefined, {
      reportOutcome: false
    })

    apiClient.request.mockImplementationOnce(async () => {
      owner = `${COMPANY}|d|another|2`
      return answer
    })
    await service.sweep(COMPANY)
    expect(repository.markAvailable).toHaveBeenCalledTimes(1)
  })
})
