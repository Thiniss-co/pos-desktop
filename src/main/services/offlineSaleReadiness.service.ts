import type {
  OfflineSaleInventoryWarning,
  OfflineSaleLimitingReason,
  OfflineSaleReadiness
} from '@shared/contracts/offlineSaleReadiness.contract'
import type { SqliteDatabase } from '../database/connection'
import type { OfflineSaleAuthorityRepository } from '../repositories/offlineSaleAuthority.repository'
import type { CatalogTrustedClock } from './catalogTrustedClock.service'

/** The owner whose readiness is being projected. Resolved in main, never supplied by the renderer. */
export interface OfflineSaleReadinessOwner {
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly warehouseUuid: string
}

export interface OfflineSaleReadinessDependencies {
  readonly database: SqliteDatabase
  readonly offlineSaleAuthorities: Pick<OfflineSaleAuthorityRepository, 'findUsable'>
  readonly trustedClock: CatalogTrustedClock
  /** Resolved from main's own session/bootstrap state. Null before login or bootstrap. */
  readonly resolveOwner: () => OfflineSaleReadinessOwner | null
  /** Boundaries observed from the licence/access snapshot, as ISO instants. */
  readonly resolveBoundaries?: () => OfflineSaleBoundaries
}

/**
 * Boundaries the desktop has observed that may end the sell window earlier than the authority does.
 *
 * These are **observations**, not authority: the server already clipped `not_after` to every
 * boundary it knew at issuance (§6.3a). These only ever move the displayed deadline EARLIER, never
 * later, so a stale or missing value cannot lengthen a countdown.
 */
export interface OfflineSaleBoundaries {
  readonly licenseValidUntil?: string | null
  readonly subscriptionExpiresAt?: string | null
  readonly subscriptionGraceEndsAt?: string | null
  readonly catalogValidUntil?: string | null
  /** Non-time blocks, e.g. `device-blocked`, `permission-denied`, `shift-closed`. */
  readonly categoricalBlocks?: readonly string[]
}

/**
 * PS6 §14.3 — the operator-facing readiness projection for offline selling.
 *
 * ## Readiness here is not preparation
 *
 * In `physical_presence` there is no mandatory "prepare stock" step. Selling is permitted by a
 * server-issued authority; stock preparation is neither necessary nor sufficient for it. This
 * service therefore reports a *window and its limits*, never a preparation target, and the legacy
 * preparation surface is untouched for `allocation_exclusive` deployments.
 *
 * ## The countdown can only ever shrink
 *
 * `remainingSeconds` is re-derived on every read from
 *
 * ```text
 * effectiveUntil    = MIN(authority.not_after, every boundary observed since)
 * remainingSeconds  = max(0, effectiveUntil - trustedNow)
 * ```
 *
 * Nothing in this class moves a deadline later. §14.3 is explicit that the window never resets on
 * launch, navigation, a refresh-only cycle, a retry that does not reach the server, or a clock
 * rollback — only a genuinely new successful online validation mints a new authority, and that
 * happens on the server.
 *
 * ## Trusted time, or no number at all
 *
 * When trusted time is unavailable the answer is `clockUntrusted: true` and a null countdown.
 * Falling back to the wall clock would let a rolled-back clock display a window that does not
 * exist, which is precisely the failure §14.3 names.
 */
export class OfflineSaleReadinessService {
  constructor(private readonly dependencies: OfflineSaleReadinessDependencies) {}

  read(): OfflineSaleReadiness {
    const owner = this.dependencies.resolveOwner()
    const trusted = this.dependencies.trustedClock.now()
    const boundaries = this.dependencies.resolveBoundaries?.() ?? {}
    const categoricalBlocks = [...(boundaries.categoricalBlocks ?? [])]

    if (owner === null) {
      return this.legacy(categoricalBlocks, trusted === null, 0, null, [])
    }

    const pendingUploadCount = this.countPendingUploads(owner)
    const lastSuccessfulSyncAt = this.lastSuccessfulSyncAt(owner)
    const inventoryWarnings = this.inventoryWarnings(owner)

    if (trusted === null) {
      // No trusted clock means no honest countdown — and no honest authority check either, since the
      // window is a time comparison. Reporting legacy mode is the conservative answer.
      return this.legacy(
        categoricalBlocks,
        true,
        pendingUploadCount,
        lastSuccessfulSyncAt,
        inventoryWarnings
      )
    }

    const nowIso = trusted.now.toISOString()
    const authority = this.dependencies.offlineSaleAuthorities.findUsable(
      owner.companyUuid,
      owner.deviceUuid,
      nowIso
    )

    if (authority === null) {
      return this.legacy(
        categoricalBlocks,
        false,
        pendingUploadCount,
        lastSuccessfulSyncAt,
        inventoryWarnings
      )
    }

    const { effectiveUntil, limitingReason } = this.resolveEffectiveDeadline(
      authority.notAfter,
      boundaries
    )
    const remainingSeconds = Math.max(
      0,
      Math.floor((Date.parse(effectiveUntil) - trusted.now.getTime()) / 1000)
    )

    return {
      mode: 'physical_presence',
      // A categorical block stops selling even while time remains, so it is folded into the
      // permission — but reported separately, never as a countdown.
      canSellWithoutQuota: remainingSeconds > 0 && categoricalBlocks.length === 0,
      authorityUuid: authority.authorityUuid,
      notAfter: effectiveUntil,
      remainingSeconds,
      limitingReason,
      categoricalBlocks,
      pendingUploadCount,
      lastSuccessfulSyncAt,
      inventoryWarnings: [...inventoryWarnings],
      clockUntrusted: false
    }
  }

  /**
   * The earliest applicable deadline, and which boundary produced it.
   *
   * The authority's own `not_after` is the starting point and every observed boundary may only pull
   * it earlier. A boundary that is absent, unparseable, or later than the current deadline is
   * skipped — never treated as zero, and never allowed to extend the window.
   */
  private resolveEffectiveDeadline(
    notAfter: string,
    boundaries: OfflineSaleBoundaries
  ): { effectiveUntil: string; limitingReason: OfflineSaleLimitingReason } {
    let effectiveUntil = notAfter
    let limitingReason: OfflineSaleLimitingReason = 'authority_ceiling'

    const candidates: Array<[string | null | undefined, OfflineSaleLimitingReason]> = [
      [boundaries.licenseValidUntil, 'license_validation'],
      [boundaries.subscriptionExpiresAt, 'subscription_expiry'],
      [boundaries.subscriptionGraceEndsAt, 'subscription_grace'],
      [boundaries.catalogValidUntil, 'catalog_contract']
    ]

    for (const [candidate, reason] of candidates) {
      if (candidate == null) {
        continue
      }

      const parsed = Date.parse(candidate)

      if (Number.isNaN(parsed) || parsed >= Date.parse(effectiveUntil)) {
        continue
      }

      effectiveUntil = new Date(parsed).toISOString()
      limitingReason = reason
    }

    return { effectiveUntil, limitingReason }
  }

  private legacy(
    categoricalBlocks: readonly string[],
    clockUntrusted: boolean,
    pendingUploadCount: number,
    lastSuccessfulSyncAt: string | null,
    inventoryWarnings: readonly OfflineSaleInventoryWarning[]
  ): OfflineSaleReadiness {
    return {
      mode: 'allocation_exclusive',
      canSellWithoutQuota: false,
      authorityUuid: null,
      notAfter: null,
      // Null rather than 0: there is no window, which is a different statement from "the window has
      // ended". Zero would render as an expired countdown that never existed.
      remainingSeconds: null,
      limitingReason: 'none',
      categoricalBlocks: [...categoricalBlocks],
      pendingUploadCount,
      lastSuccessfulSyncAt,
      inventoryWarnings: [...inventoryWarnings],
      clockUntrusted
    }
  }

  /** Sales committed locally that the server has not yet acknowledged. */
  private countPendingUploads(owner: OfflineSaleReadinessOwner): number {
    const row = this.dependencies.database
      .prepare(
        `SELECT COUNT(*) AS n FROM local_invoices
          WHERE company_uuid = ? AND device_uuid = ?
            AND sync_status IN ('pending','uploading','retryable_error')`
      )
      .get(owner.companyUuid, owner.deviceUuid) as { n: number } | undefined

    return row?.n ?? 0
  }

  private lastSuccessfulSyncAt(owner: OfflineSaleReadinessOwner): string | null {
    const row = this.dependencies.database
      .prepare(
        `SELECT MAX(synced_at) AS at FROM local_invoices
          WHERE company_uuid = ? AND device_uuid = ? AND sync_status = 'synced'`
      )
      .get(owner.companyUuid, owner.deviceUuid) as { at: string | null } | undefined

    return row?.at ?? null
  }

  /**
   * Products whose cached balance is at or below zero, for a NON-BLOCKING warning.
   *
   * Read from the advisory bootstrapped catalog balance, which authorizes nothing — that is already
   * the standing rule (`desktop-frontend-integration-rules.md` #13), and this mode reaffirms rather
   * than relaxes it. Bounded to a handful of rows because this is a banner, not a report.
   */
  private inventoryWarnings(
    owner: OfflineSaleReadinessOwner
  ): readonly OfflineSaleInventoryWarning[] {
    const rows = this.dependencies.database
      .prepare(
        `SELECT s.product_uuid AS product_uuid,
                COALESCE(p.name, s.product_uuid) AS product_name,
                s.quantity AS quantity
           FROM catalog_stock_items s
           LEFT JOIN catalog_products p ON p.uuid = s.product_uuid
          WHERE s.warehouse_uuid = ?
          LIMIT 500`
      )
      .all(owner.warehouseUuid) as Array<{
      product_uuid: string
      product_name: string
      quantity: string
    }>

    const warnings: OfflineSaleInventoryWarning[] = []

    for (const row of rows) {
      const cachedQuantityMilli = signedQuantityToMilli(row.quantity)

      if (cachedQuantityMilli === null || cachedQuantityMilli > 0) {
        continue
      }

      warnings.push({
        productUuid: row.product_uuid,
        productName: row.product_name,
        cachedQuantityMilli,
        atOrBelowZero: true
      })
    }

    // Bounded: this drives a banner, not a report. Deepest deficits first, because those are the
    // ones an operator would want to see named.
    return warnings.sort((a, b) => a.cachedQuantityMilli - b.cachedQuantityMilli).slice(0, 20)
  }
}

/**
 * Parse a cached catalog balance, which is SIGNED once the physical-presence mode is active.
 *
 * Deliberately not `quantityToMilli()` from the fingerprint helper: that one rejects a leading `-`,
 * because a *sale* quantity is never negative. A cached warehouse balance is a different quantity
 * with a different domain, and after PS2 it can legitimately be below zero — so reusing the stricter
 * parser here would throw on exactly the rows this warning exists to surface.
 *
 * Returns null for anything unparseable rather than guessing: an unreadable balance is not evidence
 * of a deficit.
 */
function signedQuantityToMilli(quantity: string): number | null {
  const match = /^(-)?(\d+)(?:\.(\d{1,3}))?$/.exec(quantity.trim())

  if (!match) {
    return null
  }

  const magnitude = Number(match[2]) * 1000 + Number((match[3] ?? '').padEnd(3, '0'))

  return match[1] === '-' ? -magnitude : magnitude
}
