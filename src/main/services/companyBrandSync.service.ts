import { createHash } from 'node:crypto'
import { companyBrandAssetRoute } from '@shared/constants/apiRoutes'
import { isPublicAppError } from '../http/apiError'
import type { DesktopApiClient } from '../http/desktopApiClient'
import { companyBrandAssetResponseSchema } from '../http/desktopResources.contract'
import type {
  CompanyBrandingRepository,
  PendingCompanyLogo
} from '../repositories/companyBranding.repository'

/**
 * Owner UX plan P9 — fetches the company logo after a persisted bootstrap, with the same contract as the product
 * image worker: fire and forget (nothing waits for it), one request at a time, a context token (company, device,
 * user, epoch) checked before the request and again before the write, connectivity outcomes not reported, and an
 * access refusal handled by the client's session/security path and ending the attempt. Bytes are trusted only when
 * the sha256, PNG signature, length and decoded size agree with the declaration.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** 128 KiB of bytes is at most 174 764 base64 characters. */
const MAX_LOGO_BASE64_LENGTH = 174_764

export interface CompanyBrandSyncDependencies {
  readonly repository: Pick<
    CompanyBrandingRepository,
    'findPendingLogo' | 'markAvailable' | 'markFailed'
  >
  readonly apiClient: Pick<DesktopApiClient, 'request'>
  /** `${companyUuid}|${deviceUuid}|${userUuid}|${sessionEpoch}` of the signed-in owner, or null. */
  readonly contextKey: () => string | null
  readonly decodePng: (buffer: Buffer) => { widthPx: number; heightPx: number } | null
  readonly now?: () => Date
  readonly onStored?: () => void
}

export function verifyCompanyLogoBytes(
  expected: PendingCompanyLogo,
  parsed: {
    sha256: string
    byte_length: number
    width_px: number
    height_px: number
    content_base64: string
  },
  decodePng: (buffer: Buffer) => { widthPx: number; heightPx: number } | null
): Buffer | null {
  if (parsed.sha256 !== expected.sha256 || parsed.content_base64.length > MAX_LOGO_BASE64_LENGTH) {
    return null
  }
  const content = Buffer.from(parsed.content_base64, 'base64')
  if (content.length !== parsed.byte_length || content.length !== expected.byteLength) {
    return null
  }
  if (content.subarray(0, 8).compare(PNG_SIGNATURE) !== 0) {
    return null
  }
  if (createHash('sha256').update(content).digest('hex') !== expected.sha256) {
    return null
  }
  const decoded = decodePng(content)
  if (!decoded || decoded.widthPx !== expected.widthPx || decoded.heightPx !== expected.heightPx) {
    return null
  }

  return content
}

export class CompanyBrandSyncService {
  private running = false
  /** A sweep requested while one was running (a newer bootstrap): run once more when it ends. */
  private rerunFor: string | null = null
  private readonly now: () => Date

  constructor(private readonly dependencies: CompanyBrandSyncDependencies) {
    this.now = dependencies.now ?? (() => new Date())
  }

  async sweep(companyUuid: string): Promise<void> {
    if (this.running) {
      this.rerunFor = companyUuid
      return
    }
    const token = this.dependencies.contextKey()
    if (token === null || !token.startsWith(`${companyUuid}|`)) {
      return
    }
    const pending = this.dependencies.repository.findPendingLogo(companyUuid, this.now())
    if (pending === null) {
      return
    }
    this.running = true
    let stored = false
    let refused = false

    try {
      let response: unknown
      try {
        response = await this.dependencies.apiClient.request(
          companyBrandAssetRoute(pending.sha256),
          undefined,
          {
            reportOutcome: false
          }
        )
      } catch (error) {
        refused =
          isPublicAppError(error) &&
          (error.category === 'authentication' || error.category === 'authorization')
        if (!refused && this.dependencies.contextKey() === token) {
          this.dependencies.repository.markFailed(
            companyUuid,
            pending.sha256,
            this.now().toISOString()
          )
        }
        return
      }
      const parsed = companyBrandAssetResponseSchema.safeParse(response)
      const verified = parsed.success
        ? verifyCompanyLogoBytes(pending, parsed.data, this.dependencies.decodePng)
        : null
      if (this.dependencies.contextKey() !== token) {
        return
      }
      if (verified === null) {
        this.dependencies.repository.markFailed(
          companyUuid,
          pending.sha256,
          this.now().toISOString()
        )
        return
      }
      stored = this.dependencies.repository.markAvailable(
        companyUuid,
        pending.sha256,
        verified,
        this.now().toISOString()
      )
    } catch {
      // A logo failure never surfaces: the name and the default brand are shown; the next bootstrap retries.
    } finally {
      this.running = false
      if (stored) {
        try {
          this.dependencies.onStored?.()
        } catch {
          // A notification failure never affects the stored logo.
        }
      }
      const rerun = this.rerunFor
      this.rerunFor = null
      if (rerun !== null && !refused) {
        void this.sweep(rerun)
      }
    }
  }
}
