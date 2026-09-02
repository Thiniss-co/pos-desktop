import type { BootstrapResult } from '@shared/contracts/bootstrap.contract'
import {
  catalogRefreshResultSchema,
  type CatalogRefreshResult,
  type CatalogStatus
} from '@shared/contracts/catalog.contract'
import type { CommercialAccessSnapshot, LicenseStatus } from '@shared/contracts/license.contract'

/**
 * The existing device license-validation endpoint. It is the *first* step of a workstation
 * refresh, not an optional extra: an overdue license denies `canSync`, so bootstrap — and every
 * step after it — cannot succeed until validation has run and been persisted.
 *
 * `LicenseService.validate()` owns persistence entirely: it stores the returned token in OS-secured
 * storage and writes the parsed status together with a server-derived trusted-time anchor. No
 * caller, and certainly no renderer, supplies `validatedAt` or any other license authority.
 */
export interface CatalogRefreshLicenseValidator {
  validate(): Promise<LicenseStatus>
}

export interface CatalogRefreshAccessDescriber {
  describe(): CommercialAccessSnapshot
}

/**
 * Re-establishes the authenticated session, active user, and company/device context before any
 * refresh work runs. The renderer never supplies these — a refresh acts on whoever main already
 * knows is signed in on this bound device.
 */
export interface CatalogRefreshAuthorizer {
  ensureCatalogReadContext(): Promise<void>
}

/**
 * The existing authoritative bootstrap refresh: device-activation check, `assertCanSync()`
 * authorization, the `/api/v1/desktop/bootstrap` request, contract validation, and the single
 * transaction that atomically replaces the cached catalogue.
 */
export interface CatalogRefreshSource {
  refresh(): Promise<BootstrapResult>
}

/** Final main-owned reconciliation after any refresh that can change session/bootstrap context. */
export interface CatalogRefreshShiftReconciler {
  current(): Promise<unknown>
}

export interface CatalogRefreshStatusReader {
  getStatus(): CatalogStatus
}

/**
 * CP-5D-G: sanitized counts describing what the refresh actually left persisted. Read-only, and
 * deliberately not part of any authority path — a refresh still never creates or tops up a grant.
 */
export interface CatalogRefreshAllocationDiagnostics {
  diagnostics(nowIso: string): {
    readonly present: boolean
    readonly revision: number | null
    readonly total: number
    readonly usable: number
  }
}

export interface CatalogRefreshAccessPublisher {
  begin(): number
  publish(revision: number): void
}

export interface CatalogRefreshDependencies {
  readonly license: CatalogRefreshLicenseValidator
  readonly authorizer: CatalogRefreshAuthorizer
  readonly source: CatalogRefreshSource
  readonly shiftReconciler: CatalogRefreshShiftReconciler
  readonly catalog: CatalogRefreshStatusReader
  readonly access: CatalogRefreshAccessDescriber
  readonly accessPublisher: CatalogRefreshAccessPublisher
  readonly stockAllocations?: CatalogRefreshAllocationDiagnostics
  readonly now?: () => Date
}

/**
 * `catalog:refresh` — the single cashier-facing **"refresh workstation data"** recovery action,
 * offered beside both the stale-catalog warning and the overdue-license message.
 *
 * This service adds no new authority and no new network route. It composes the existing
 * authoritative pieces in the one order that actually works:
 *
 *   1. read the revision the workstation is currently selling against, *before* anything changes;
 *   2. **validate the license first.** This ordering is not cosmetic: an overdue license denies
 *      `canSync`, and `BootstrapService.refresh()` calls `assertCanSync()`, so every later step
 *      fails until validation succeeds and is persisted. Publishing the refreshed access decision
 *      immediately afterwards is what makes the overdue warning disappear rather than linger until
 *      the whole chain finishes;
 *   3. re-establish session/device/company context (`ensureCatalogReadContext`);
 *   4. run the authoritative bootstrap refresh, which performs its own activation and `canSync`
 *      authorization and persists catalogue, payment methods, customers, and warehouse stock in one
 *      transaction;
 *   5. reconcile the authoritative current shift last, so a confirmed open observation is never
 *      compared with pre-refresh session/bootstrap context;
 *   6. publish the access decision again, so an entitlement change the bootstrap itself revealed
 *      also reaches the renderer;
 *   7. recalculate catalog status immediately, so the caller never has to infer freshness from
 *      the mere fact that the call returned.
 *
 * **Fail-closed.** If license validation fails, nothing later runs, no access snapshot is
 * published, and the real transport/business error propagates unchanged for the renderer to show.
 * The previously persisted (denied) state is left exactly as it was — a failed refresh never
 * softens a restriction.
 *
 * Concurrent callers are coalesced onto one in-flight refresh. `BootstrapService.refresh()`
 * already coalesces its own network/persist work; this second guard exists because the
 * `begin()`/`publish()` pair and the before/after revision comparison are this service's own
 * state, and interleaving two of those would publish a stale access snapshot or compare against
 * a revision another call had already replaced.
 *
 * It deliberately reports `revisionChanged` rather than acting on it: deciding what happens to an
 * open cart is the renderer's job, and the only sanctioned outcomes there are an explicit rebuild
 * or an explicit clear — never a silent reprice.
 */
export class CatalogRefreshService {
  private inFlight: Promise<CatalogRefreshResult> | null = null

  constructor(private readonly dependencies: CatalogRefreshDependencies) {}

  refresh(): Promise<CatalogRefreshResult> {
    if (this.inFlight) {
      return this.inFlight
    }

    const refresh = this.refreshOnce()
    this.inFlight = refresh
    void refresh.then(
      () => this.clear(refresh),
      () => this.clear(refresh)
    )

    return refresh
  }

  private clear(refresh: Promise<CatalogRefreshResult>): void {
    if (this.inFlight === refresh) {
      this.inFlight = null
    }
  }

  /**
   * Reported so a support session can tell "no allocation exists" apart from "an allocation exists
   * but is not usable here" without reading the database. It never tells the cashier that a refresh
   * created or topped up a grant, because it does not.
   */
  private allocationDiagnostics(): Record<string, unknown> {
    const stockAllocations = this.dependencies.stockAllocations

    if (!stockAllocations) {
      return {}
    }

    const now = this.dependencies.now ?? (() => new Date())
    const diagnostics = stockAllocations.diagnostics(now().toISOString())

    return {
      allocationDataPresent: diagnostics.present,
      stockAllocationRevision: diagnostics.revision,
      stockAllocationCount: diagnostics.total,
      usableStockAllocationCount: diagnostics.usable
    }
  }

  private async refreshOnce(): Promise<CatalogRefreshResult> {
    const previousRevision = this.dependencies.catalog.getStatus().contract?.revision ?? null

    // 1-2. License first. `LicenseService.validate()` calls the existing validation endpoint and
    // atomically persists the returned state, the OS-secured token, and a *server-derived* trusted
    // time anchor. Nothing here reads a timestamp or an entitlement from the caller.
    const licenseRevision = this.dependencies.accessPublisher.begin()
    const licenseStatus = await this.dependencies.license.validate()
    // Published straight away: the overdue warning clears as soon as the license is good again,
    // without waiting for the bootstrap leg that follows.
    this.dependencies.accessPublisher.publish(licenseRevision)

    // 3. Session, device, and company context.
    await this.dependencies.authorizer.ensureCatalogReadContext()

    // 4. Bootstrap: catalogue, payment methods, customers, warehouse stock, and whatever
    // allocation data the server provides, replaced in one transaction.
    const bootstrapRevision = this.dependencies.accessPublisher.begin()
    const result = await this.dependencies.source.refresh()

    // 5. `ShiftService.current()` persists its authoritative response before resolving. No
    // renderer state participates, and a missing `shifts.view` permission remains a real error.
    await this.dependencies.shiftReconciler.current()

    // 6. Publish only after the durable bootstrap and final shift observation settle.
    this.dependencies.accessPublisher.publish(bootstrapRevision)

    // 7. Recalculated from the rows just committed, never from a cached value.
    const status = this.dependencies.catalog.getStatus()

    return catalogRefreshResultSchema.parse({
      status,
      refreshedAt: result.fetchedAt,
      previousRevision,
      revisionChanged: previousRevision !== null && previousRevision !== result.catalog.revision,
      counts: result.counts,
      // Returned so the renderer can drop a stale block immediately, without waiting for the
      // pushed access event or a separate round trip.
      access: this.dependencies.access.describe(),
      licenseValidatedAt: licenseStatus.validatedAt ?? null,
      ...this.allocationDiagnostics()
    })
  }
}
