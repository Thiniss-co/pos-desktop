import { createHash } from 'node:crypto'
import { productImageAssetRoute } from '@shared/constants/apiRoutes'
import { isPublicAppError } from '../http/apiError'
import type { DesktopApiClient } from '../http/desktopApiClient'
import {
  PRODUCT_IMAGE_MAX_BASE64_LENGTH,
  productImageAssetResponseSchema,
  type ProductImageAssetResponse
} from '../http/desktopResources.contract'
import type {
  PendingProductImageAsset,
  ProductImageRepository
} from '../repositories/productImage.repository'

/**
 * Owner UX plan P8 — the register's background product-image worker.
 *
 * - Runs after a bootstrap was persisted and settled (never inside the catalog-install hold), fire
 *   and forget: catalog install and checkout never wait for images; a missing, pending or failed image
 *   renders the product's monogram.
 * - One sweep at a time; at most 200 assets and 16 MiB per sweep; one request at a time.
 * - Captures a context token (company, device, user, session epoch) and re-checks it before every
 *   request and again right before every write; any change stops the sweep and discards the result.
 * - Bytes are trusted only when the base64 length, decoded length, sha256, WebP signature and the
 *   bitstream's declared size all agree with what the server declared. A failed asset is retried on a later bootstrap only
 *   (the repository skips it after three failures until a newer reference names it).
 * - Asset requests do not report connectivity outcomes (an image failure never flips the till
 *   offline), but authentication and revocation answers still go through the client's normal
 *   session/security handling, and stop the sweep.
 */

export const MAX_ASSETS_PER_SWEEP = 200
export const MAX_BYTES_PER_SWEEP = 16 * 1024 * 1024

const WEBP_RIFF = Buffer.from('RIFF', 'ascii')
const WEBP_TAG = Buffer.from('WEBP', 'ascii')

export interface ProductImageSyncDependencies {
  readonly repository: Pick<
    ProductImageRepository,
    'findPendingAssets' | 'markAvailable' | 'markFailed'
  >
  readonly apiClient: Pick<DesktopApiClient, 'request'>
  /** `${companyUuid}|${deviceUuid}|${userUuid}|${sessionEpoch}` of the signed-in owner, or null. */
  readonly contextKey: () => string | null
  readonly decodeWebp?: (buffer: Buffer) => { widthPx: number; heightPx: number } | null
  readonly now?: () => Date
  readonly log?: (line: string) => void
  /** Called once after a sweep stored at least one image, so open product views re-read. */
  readonly onStored?: () => void
}

/** Never trust downloaded bytes before every declared property agrees with what arrived. */
export function verifyProductImageAssetBytes(
  expected: PendingProductImageAsset,
  parsed: ProductImageAssetResponse,
  decodeWebp: (buffer: Buffer) => { widthPx: number; heightPx: number } | null
): Buffer | null {
  if (
    parsed.sha256 !== expected.sha256 ||
    parsed.content_base64.length > PRODUCT_IMAGE_MAX_BASE64_LENGTH
  ) {
    return null
  }
  const content = Buffer.from(parsed.content_base64, 'base64')
  if (content.length !== parsed.byte_length || content.length !== expected.byteLength) {
    return null
  }
  if (
    content.subarray(0, 4).compare(WEBP_RIFF) !== 0 ||
    content.subarray(8, 12).compare(WEBP_TAG) !== 0
  ) {
    return null
  }
  if (createHash('sha256').update(content).digest('hex') !== expected.sha256) {
    return null
  }
  const decoded = decodeWebp(content)
  if (
    !decoded ||
    decoded.widthPx !== parsed.width_px ||
    decoded.heightPx !== parsed.height_px ||
    decoded.widthPx !== expected.widthPx ||
    decoded.heightPx !== expected.heightPx
  ) {
    return null
  }

  return content
}

/**
 * The canvas size declared by a WebP bitstream header (simple lossy `VP8 `, lossless `VP8L`, or
 * extended `VP8X`). Electron's main-process image decoder does not read WebP, so the register checks
 * the bitstream's own dimensions against the server's declaration; the sha256 already pins the exact
 * bytes, and the renderer shows the monogram for an image Chromium cannot draw.
 */
export function readWebpDimensions(buffer: Buffer): { widthPx: number; heightPx: number } | null {
  if (buffer.length < 30) {
    return null
  }
  const chunk = buffer.toString('ascii', 12, 16)
  if (chunk === 'VP8 ') {
    // Frame header: 3-byte tag, then the start code 9d 01 2a, then 14-bit width and height.
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) {
      return null
    }
    return { widthPx: buffer.readUInt16LE(26) & 0x3fff, heightPx: buffer.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    if (buffer[20] !== 0x2f) {
      return null
    }
    const bits = buffer.readUInt32LE(21)
    return { widthPx: (bits & 0x3fff) + 1, heightPx: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    return { widthPx: buffer.readUIntLE(24, 3) + 1, heightPx: buffer.readUIntLE(27, 3) + 1 }
  }
  return null
}

export class ProductImageSyncService {
  private running = false
  private stopped = false
  /** A sweep requested while one was running (a newer bootstrap): run once more when it ends. */
  private rerunFor: string | null = null
  private readonly now: () => Date
  private readonly decodeWebp: (buffer: Buffer) => { widthPx: number; heightPx: number } | null

  constructor(private readonly dependencies: ProductImageSyncDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.decodeWebp = dependencies.decodeWebp ?? readWebpDimensions
  }

  /** Logout, device block or revocation: the current sweep stops at its next check. */
  stop(): void {
    this.stopped = true
  }

  /** A new session may sweep again. */
  resume(): void {
    this.stopped = false
  }

  /** One bounded sweep of the company's pending assets. Never throws. */
  async sweep(companyUuid: string): Promise<void> {
    if (this.stopped) {
      return
    }
    if (this.running) {
      // The running sweep read its pending list before this bootstrap persisted: queue one more.
      this.rerunFor = companyUuid
      return
    }
    const token = this.dependencies.contextKey()
    if (token === null || !token.startsWith(`${companyUuid}|`)) {
      return
    }
    this.running = true

    let stored = 0
    let refused = false

    try {
      let bytes = 0
      const pending = this.dependencies.repository.findPendingAssets(
        companyUuid,
        MAX_ASSETS_PER_SWEEP
      )
      for (const asset of pending) {
        if (bytes + asset.byteLength > MAX_BYTES_PER_SWEEP || !this.current(token)) {
          return
        }
        const outcome = await this.fetchOne(companyUuid, asset, token)
        if (outcome === 'stop') {
          refused = true
          return
        }
        stored += outcome === 'ok' ? 1 : 0
        bytes += asset.byteLength
      }
    } catch {
      // A sweep failure is never surfaced: images are optional; the next bootstrap retries.
    } finally {
      this.running = false
      if (stored > 0) {
        try {
          this.dependencies.onStored?.()
        } catch {
          // A notification failure never affects stored images.
        }
      }
      const rerun = this.rerunFor
      this.rerunFor = null
      // A refusal (sign-out, revocation) ends the work; anything else queued runs once more.
      if (rerun !== null && !refused) {
        void this.sweep(rerun)
      }
    }
  }

  private current(token: string): boolean {
    return !this.stopped && this.dependencies.contextKey() === token
  }

  private async fetchOne(
    companyUuid: string,
    asset: PendingProductImageAsset,
    token: string
  ): Promise<'ok' | 'failed' | 'stop'> {
    let response: unknown
    try {
      response = await this.dependencies.apiClient.request(
        productImageAssetRoute(asset.sha256),
        undefined,
        { reportOutcome: false }
      )
    } catch (error) {
      if (
        isPublicAppError(error) &&
        (error.category === 'authentication' || error.category === 'authorization')
      ) {
        // The client already ran the session/security handling; nothing more is fetched now.
        this.dependencies.log?.('[pos-images] sweep stopped: access refused')
        return 'stop'
      }
      if (this.current(token)) {
        this.dependencies.repository.markFailed(companyUuid, asset.sha256, this.now().toISOString())
      }
      return 'failed'
    }

    const parsed = productImageAssetResponseSchema.safeParse(response)
    const verified = parsed.success
      ? verifyProductImageAssetBytes(asset, parsed.data, this.decodeWebp)
      : null
    if (!this.current(token)) {
      return 'stop'
    }
    if (verified === null) {
      this.dependencies.repository.markFailed(companyUuid, asset.sha256, this.now().toISOString())
      return 'failed'
    }
    this.dependencies.repository.markAvailable(
      companyUuid,
      asset.sha256,
      verified,
      this.now().toISOString()
    )

    return 'ok'
  }
}
