import { createHash } from 'node:crypto'
import { nativeImage } from 'electron'
import { receiptProfileAssetRoute } from '@shared/constants/apiRoutes'
import {
  receiptProfileAssetResponseSchema,
  type CompanyReceiptProfileResource
} from '../http/desktopResources.contract'
import type { DesktopApiClient } from '../http/desktopApiClient'
import type {
  IncomingReceiptProfileVersion,
  ReceiptProfileRepository
} from '../repositories/receiptProfile.repository'

/**
 * Receipt-printing plan §D-11 — the desktop half of company receipt branding. Laravel is
 * authoritative (§D-10); this service only ever mirrors what a negotiated bootstrap response or an
 * admin-publish response already returned, through `ReceiptProfileRepository.ingest`'s monotonic
 * protocol (§D-11 "Correction B"), and separately fetches + verifies logo bytes for a `pending`
 * asset (never trusted before verification).
 */

const MAX_PNG_DIMENSION_PX = 384
const MAX_LOGO_HEIGHT_PX = 192
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface ReceiptProfileSyncDependencies {
  readonly repository: Pick<
    ReceiptProfileRepository,
    'ingest' | 'findPendingAssets' | 'markAssetAvailable'
  >
  readonly apiClient: Pick<DesktopApiClient, 'request'>
  readonly now?: () => Date
  /** Test-only escape hatch: production always uses the real decoded size from `nativeImage`. */
  readonly decodePng?: (buffer: Buffer) => { widthPx: number; heightPx: number } | null
}

/** The real decoder, shared with `ReceiptProfileAdminService` so both entry points that trust
 *  downloaded logo bytes apply the exact same decode step. */
export function decodeNativePng(buffer: Buffer): { widthPx: number; heightPx: number } | null {
  const image = nativeImage.createFromBuffer(buffer)
  const size = image.getSize()
  return size.width > 0 && size.height > 0 ? { widthPx: size.width, heightPx: size.height } : null
}

export interface VerifiedReceiptProfileAsset {
  readonly content: Buffer
  readonly widthPx: number
  readonly heightPx: number
}

interface RawReceiptProfileAssetResponse {
  readonly sha256: string
  readonly media_type: string
  readonly width_px: number
  readonly height_px: number
  readonly byte_length: number
  readonly content_base64: string
}

/**
 * Shared by the background bootstrap sync (§D-11 asset fetch) and the admin editor's
 * choose-logo upload round-trip: never trust downloaded bytes before the sha256, PNG signature,
 * declared length and decoded dimensions all agree with what the server claimed.
 */
export function verifyReceiptProfileAssetBytes(
  expectedSha256: string,
  parsed: RawReceiptProfileAssetResponse,
  decodePng: (buffer: Buffer) => { widthPx: number; heightPx: number } | null
): VerifiedReceiptProfileAsset | null {
  if (parsed.sha256 !== expectedSha256) {
    return null // never trust a response naming a different asset than requested
  }

  const content = Buffer.from(parsed.content_base64, 'base64')

  if (content.length !== parsed.byte_length || content.length !== content.byteLength) {
    return null
  }
  if (content.subarray(0, 8).compare(PNG_SIGNATURE) !== 0) {
    return null
  }
  if (createHash('sha256').update(content).digest('hex') !== expectedSha256) {
    return null
  }

  const decoded = decodePng(content)
  if (
    !decoded ||
    decoded.widthPx !== parsed.width_px ||
    decoded.heightPx !== parsed.height_px ||
    decoded.widthPx > MAX_PNG_DIMENSION_PX ||
    decoded.heightPx > MAX_LOGO_HEIGHT_PX
  ) {
    return null
  }

  return { content, widthPx: decoded.widthPx, heightPx: decoded.heightPx }
}

function toIncomingVersion(
  resource: CompanyReceiptProfileResource
): IncomingReceiptProfileVersion | null {
  if (!resource.profile) {
    return null
  }
  const profile = resource.profile
  return {
    versionUuid: profile.uuid,
    revision: profile.revision,
    addressLines: profile.address_lines,
    phone: profile.phone,
    taxIdentifierLabel: profile.tax_identifier_label,
    taxIdentifierValue: profile.tax_identifier_value,
    footerLines: profile.footer_lines,
    logo: profile.logo
      ? {
          sha256: profile.logo.sha256,
          mediaType: profile.logo.media_type,
          widthPx: profile.logo.width_px,
          heightPx: profile.logo.height_px,
          byteLength: profile.logo.byte_length
        }
      : null
  }
}

export class ReceiptProfileSyncService {
  private readonly now: () => Date
  private readonly decodePng: (buffer: Buffer) => { widthPx: number; heightPx: number } | null
  /** One in-flight asset-fetch sweep per company at a time -- a second bootstrap refresh or a
   *  fresh publish while a fetch is already running must not fire an overlapping duplicate sweep. */
  private readonly fetchInFlight = new Set<string>()

  constructor(private readonly dependencies: ReceiptProfileSyncDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.decodePng = dependencies.decodePng ?? decodeNativePng
  }

  /**
   * Ingests a negotiated bootstrap `receipt_profile` block for exactly the responding company and
   * user. Absence (the key was not negotiated, or the response predates the block) is a no-op --
   * never inferred as "no profile". Never throws: a mirror-ingest failure must never fail
   * bootstrap or block a sale, so any unexpected error here is swallowed after being applied
   * best-effort up to the point it failed (the ingest transaction itself is all-or-nothing).
   */
  ingestFromBootstrap(
    companyUuid: string,
    userUuid: string | null,
    block: CompanyReceiptProfileResource | undefined
  ): void {
    if (block === undefined) {
      return
    }

    try {
      this.dependencies.repository.ingest(
        companyUuid,
        userUuid,
        block.can_manage,
        toIncomingVersion(block),
        this.now().toISOString()
      )
    } catch {
      // A mirror-ingest failure is never allowed to fail bootstrap or block a sale. The next
      // bootstrap refresh (or admin publish) retries from scratch; nothing here is partially
      // applied across calls, since `ingest` itself is one transaction.
    }
  }

  /** Ingests a fresh `PUT /receipt-profile` response for the acting admin, through the exact same
   *  monotonic protocol as a bootstrap block -- so the two entry points can never disagree about
   *  what "newer" means (plan §D-11 "Correction B"). */
  ingestPublishResponse(
    companyUuid: string,
    userUuid: string,
    resource: CompanyReceiptProfileResource
  ): void {
    this.dependencies.repository.ingest(
      companyUuid,
      userUuid,
      resource.can_manage,
      toIncomingVersion(resource),
      this.now().toISOString()
    )
  }

  /**
   * Fetches, verifies and stores every `pending` logo asset for one company. Fire-and-forget: the
   * caller never awaits this on the bootstrap or checkout path. A verification failure leaves the
   * asset `pending` for a later retry and is never treated as the asset having been rejected.
   */
  async fetchPendingAssets(companyUuid: string): Promise<void> {
    if (this.fetchInFlight.has(companyUuid)) {
      return
    }
    this.fetchInFlight.add(companyUuid)

    try {
      const pending = this.dependencies.repository.findPendingAssets(companyUuid)
      for (const { sha256 } of pending) {
        await this.fetchOneAsset(companyUuid, sha256)
      }
    } finally {
      this.fetchInFlight.delete(companyUuid)
    }
  }

  private async fetchOneAsset(companyUuid: string, sha256: string): Promise<void> {
    try {
      const response = await this.dependencies.apiClient.request(receiptProfileAssetRoute(sha256))
      const parsed = receiptProfileAssetResponseSchema.parse(response)
      const verified = verifyReceiptProfileAssetBytes(sha256, parsed, this.decodePng)

      if (!verified) {
        return
      }

      this.dependencies.repository.markAssetAvailable(
        companyUuid,
        sha256,
        verified.content,
        this.now().toISOString()
      )
    } catch {
      // Left `pending`; retried at the next bootstrap refresh or explicit editor refresh. Never
      // thrown further -- an asset fetch failure must never surface as a sale-blocking error.
    }
  }
}
