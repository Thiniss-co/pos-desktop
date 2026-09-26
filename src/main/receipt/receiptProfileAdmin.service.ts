import { extname } from 'node:path'
import type { Dialog } from 'electron'
import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import { DESKTOP_API_ROUTES, receiptProfileAssetRoute } from '@shared/constants/apiRoutes'
import {
  receiptProfileGetOutputSchema,
  receiptProfileChooseLogoOutputSchema,
  type ReceiptProfileGetOutput,
  type ReceiptProfileChooseLogoOutput,
  type ReceiptProfilePublishInput,
  type ReceiptProfileVersion
} from '@shared/contracts/printing.contract'
import {
  companyReceiptProfileResourceSchema,
  receiptProfileAssetResponseSchema,
  receiptProfileLogoUploadResponseSchema
} from '../http/desktopResources.contract'
import { isPublicAppError } from '../http/apiError'
import type { DesktopApiClient } from '../http/desktopApiClient'
import type { ConnectivityService } from '../services/connectivity.service'
import type { ReceiptOwner } from './receiptAccess.service'
import { decodeNativePng, verifyReceiptProfileAssetBytes } from './receiptProfileSync.service'
import type { ReceiptProfileSyncService } from './receiptProfileSync.service'
import type { ReceiptProfileRepository } from '../repositories/receiptProfile.repository'

/**
 * Receipt-printing plan §D-11 — the CompanyAdmin receipt-profile editor, main-owned. Every method
 * takes the caller's `ReceiptOwner` from the IPC layer's own `receiptAccess.resolveCaller()` call
 * (the session check); this service is responsible only for the SECOND check, `canManage`
 * (§D-10 "Correction A" — the server-computed verdict mirrored locally, fail-closed), and for the
 * "requires online" gate (BD-1b design). The renderer never sees a file path, a raw HTTP response,
 * or an unverified image byte.
 */

const MAX_LOGO_UPLOAD_BYTES = 1024 * 1024 // 1 MiB -- matches the backend's own upload bound

export interface ReceiptProfileAdminDependencies {
  readonly repository: Pick<
    ReceiptProfileRepository,
    'getCurrent' | 'getVersion' | 'getAuthority' | 'getAsset' | 'recordUploadedAsset'
  >
  readonly sync: Pick<ReceiptProfileSyncService, 'ingestPublishResponse'>
  readonly apiClient: Pick<DesktopApiClient, 'request'>
  readonly connectivity: Pick<ConnectivityService, 'getSnapshot'>
  readonly dialog: Pick<Dialog, 'showOpenDialog'>
  readonly readFile: (filePath: string) => Promise<Buffer>
  /** Best-effort only: refreshes the mirror after a 409 so the caller's next `get()` already
   *  reflects the newer version the conflict revealed. Never required for correctness. */
  readonly refreshBootstrap?: () => Promise<unknown>
  readonly now?: () => Date
  /** Test-only escape hatch; production shares `decodeNativePng` with the background asset sync. */
  readonly decodePng?: (buffer: Buffer) => { widthPx: number; heightPx: number } | null
}

function permissionDeniedError(): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'authorization',
    message: 'You do not have permission to manage the receipt profile.',
    backendCode: 'RECEIPT_PROFILE_PERMISSION_DENIED',
    retryable: false
  })
}

function offlineError(): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'transport',
    message: 'Connect to the internet to edit the receipt profile.',
    backendCode: 'RECEIPT_PROFILE_UNAVAILABLE_OFFLINE',
    retryable: true
  })
}

function noLogoChosenError(): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'validation',
    message: 'No logo file was chosen.',
    retryable: false
  })
}

function logoTooLargeError(): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'validation',
    message: 'The chosen file is too large. Choose an image up to 1 MB.',
    backendCode: 'RECEIPT_PROFILE_ASSET_INVALID',
    retryable: false
  })
}

function logoVerificationFailedError(): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'unexpected',
    message: 'The uploaded logo could not be verified. Try choosing it again.',
    backendCode: 'RECEIPT_PROFILE_ASSET_INVALID',
    retryable: true
  })
}

function invalidLogoReferenceError(): PublicAppError {
  return publicAppErrorSchema.parse({
    category: 'validation',
    message: 'Choose a logo before saving, or keep the current one.',
    retryable: false
  })
}

function mediaTypeForPath(filePath: string): 'image/png' | 'image/jpeg' {
  return extname(filePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'
}

export class ReceiptProfileAdminService {
  private readonly now: () => Date
  private readonly decodePng: (buffer: Buffer) => { widthPx: number; heightPx: number } | null
  /** Per-company set of logo sha256s this session uploaded itself, the only ones a subsequent
   *  `publish({logo:{action:'set',...}})` may reference (plan §D-11 editor contract). Cleared
   *  only by process restart -- an upload never expires within one running session. */
  private readonly uploadedLogoShas = new Map<string, Set<string>>()

  constructor(private readonly dependencies: ReceiptProfileAdminDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.decodePng = dependencies.decodePng ?? decodeNativePng
  }

  get(owner: ReceiptOwner): ReceiptProfileGetOutput {
    const current = this.dependencies.repository.getCurrent(owner.companyUuid)

    if (!current) {
      return receiptProfileGetOutputSchema.parse({
        capability: 'unsupported',
        canManage: false,
        profile: null,
        logo: null
      })
    }

    const canManage = this.dependencies.repository.getAuthority(owner.companyUuid, owner.userUuid)

    if (!current.versionUuid) {
      return receiptProfileGetOutputSchema.parse({
        capability: current.capability,
        canManage,
        profile: null,
        logo: null
      })
    }

    const version = this.dependencies.repository.getVersion(current.versionUuid, owner.companyUuid)

    if (!version) {
      // Defensive: the pointer names a version this connection cannot see. Never fabricate one.
      return receiptProfileGetOutputSchema.parse({
        capability: current.capability,
        canManage,
        profile: null,
        logo: null
      })
    }

    let logoRef: ReceiptProfileVersion['logo'] = null
    let logoState: { present: boolean; thumbnailPngDataUrl: string | null } | null = null

    if (version.logoSha256) {
      const asset = this.dependencies.repository.getAsset(owner.companyUuid, version.logoSha256)

      if (asset && asset.status === 'available' && asset.content) {
        logoRef = {
          sha256: asset.sha256,
          mediaType: asset.mediaType,
          widthPx: asset.widthPx,
          heightPx: asset.heightPx,
          byteLength: asset.byteLength
        }
        logoState = {
          present: true,
          thumbnailPngDataUrl: `data:${asset.mediaType};base64,${asset.content.toString('base64')}`
        }
      } else {
        logoState = { present: true, thumbnailPngDataUrl: null }
      }
    }

    return receiptProfileGetOutputSchema.parse({
      capability: current.capability,
      canManage,
      profile: {
        versionUuid: version.versionUuid,
        revision: version.revision,
        addressLines: [...version.addressLines],
        phone: version.phone,
        taxIdentifierLabel: version.taxIdentifierLabel,
        taxIdentifierValue: version.taxIdentifierValue,
        footerLines: [...version.footerLines],
        logo: logoRef
      },
      logo: logoState
    })
  }

  async chooseLogo(owner: ReceiptOwner): Promise<ReceiptProfileChooseLogoOutput> {
    this.assertCanManage(owner)
    this.assertOnline()

    const dialogResult = await this.dependencies.dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]
    })

    if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
      throw noLogoChosenError()
    }

    const filePath = dialogResult.filePaths[0]
    const fileContent = await this.dependencies.readFile(filePath)

    if (fileContent.byteLength > MAX_LOGO_UPLOAD_BYTES) {
      throw logoTooLargeError()
    }

    const uploadResponse = await this.dependencies.apiClient.request(
      DESKTOP_API_ROUTES.receiptProfileUploadLogo,
      { media_type: mediaTypeForPath(filePath), content_base64: fileContent.toString('base64') }
    )
    const uploaded = receiptProfileLogoUploadResponseSchema.parse(uploadResponse)

    const assetResponse = await this.dependencies.apiClient.request(
      receiptProfileAssetRoute(uploaded.sha256)
    )
    const parsedAsset = receiptProfileAssetResponseSchema.parse(assetResponse)
    const verified = verifyReceiptProfileAssetBytes(uploaded.sha256, parsedAsset, this.decodePng)

    if (!verified) {
      throw logoVerificationFailedError()
    }

    this.dependencies.repository.recordUploadedAsset(
      owner.companyUuid,
      uploaded.sha256,
      parsedAsset.media_type,
      verified.widthPx,
      verified.heightPx,
      parsedAsset.byte_length,
      verified.content,
      this.now().toISOString()
    )

    const uploadedForCompany = this.uploadedLogoShas.get(owner.companyUuid) ?? new Set<string>()
    uploadedForCompany.add(uploaded.sha256)
    this.uploadedLogoShas.set(owner.companyUuid, uploadedForCompany)

    return receiptProfileChooseLogoOutputSchema.parse({
      sha256: uploaded.sha256,
      thumbnailPngDataUrl: `data:${parsedAsset.media_type};base64,${verified.content.toString('base64')}`
    })
  }

  async publish(
    owner: ReceiptOwner,
    input: ReceiptProfilePublishInput
  ): Promise<ReceiptProfileGetOutput> {
    this.assertCanManage(owner)
    this.assertOnline()

    const logoSha256 = this.resolveLogoSha256(owner, input.logo)

    try {
      const raw = await this.dependencies.apiClient.request(
        DESKTOP_API_ROUTES.receiptProfilePublish,
        {
          expected_revision: input.expectedRevision,
          address_lines: input.fields.addressLines,
          phone: input.fields.phone,
          tax_identifier_label: input.fields.taxIdentifierLabel,
          tax_identifier_value: input.fields.taxIdentifierValue,
          footer_lines: input.fields.footerLines,
          logo_sha256: logoSha256
        }
      )
      // The publish response is wrapped exactly like a bootstrap `receipt_profile` block --
      // `{can_manage, profile}` -- not a bare version (confirmed against the real backend:
      // `CompanyReceiptProfileVersionResource::toArray()` always nests the version under
      // `profile` alongside the server-computed `can_manage`, despite its class name).
      const parsedResource = companyReceiptProfileResourceSchema.parse(raw)
      this.dependencies.sync.ingestPublishResponse(
        owner.companyUuid,
        owner.userUuid,
        parsedResource
      )
    } catch (error) {
      if (isPublicAppError(error) && error.backendCode === 'RECEIPT_PROFILE_REVISION_CONFLICT') {
        await this.dependencies.refreshBootstrap?.().catch(() => undefined)
      }

      throw error
    }

    return this.get(owner)
  }

  private assertCanManage(owner: ReceiptOwner): void {
    if (!this.dependencies.repository.getAuthority(owner.companyUuid, owner.userUuid)) {
      throw permissionDeniedError()
    }
  }

  private assertOnline(): void {
    if (this.dependencies.connectivity.getSnapshot().status !== 'online') {
      throw offlineError()
    }
  }

  private resolveLogoSha256(
    owner: ReceiptOwner,
    action: ReceiptProfilePublishInput['logo']
  ): string | null {
    if (action.action === 'remove') {
      return null
    }

    const current = this.dependencies.repository.getCurrent(owner.companyUuid)
    const currentVersion = current?.versionUuid
      ? this.dependencies.repository.getVersion(current.versionUuid, owner.companyUuid)
      : null

    if (action.action === 'keep') {
      // The backend has no "keep the existing logo" semantic (plan §D-11 finding): `logo_sha256`
      // is either the sha to set or null/absent meaning no logo. "Keep" is resolved HERE, by
      // re-sending the CURRENT version's own logo sha256 explicitly.
      return currentVersion?.logoSha256 ?? null
    }

    const uploadedThisSession = this.uploadedLogoShas.get(owner.companyUuid)
    const alreadyCurrent = currentVersion?.logoSha256 === action.sha256

    if (!alreadyCurrent && !uploadedThisSession?.has(action.sha256)) {
      throw invalidLogoReferenceError()
    }

    return action.sha256
  }
}
