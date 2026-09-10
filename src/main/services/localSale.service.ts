import { randomUUID } from 'crypto'
import type { CheckoutIntent } from '@shared/contracts/checkout.contract'
import type { ConnectivitySnapshot } from '@shared/contracts/connectivity.contract'
import type {
  LocalInvoiceItemRow,
  LocalInvoicePaymentRow,
  LocalInvoiceRow,
  LocalStockAllocationConsumptionRow,
  SaleAttemptRow,
  StockAllocationGrantRow
} from '@shared/contracts/sale.contract'
import { calculateCart } from '@shared/pos/posCalculator'
import { calculatePayments, type ResolvedPaymentMethod } from '@shared/pos/paymentCalculator'
import type { SqliteDatabase } from '../database/connection'
import { runSerializedWrite } from '../database/serializedWrite'
import {
  allocationItemLineUuid,
  allocationJournalAppend,
  allocationJournalInitialHash
} from './allocationJournal'
import { invoiceRequestHash } from './invoiceRequestHash'
import type { BootstrapSnapshotRepository } from '../repositories/bootstrapSnapshot.repository'
import type { CheckoutResolutionInput } from '../repositories/catalog.repository'
import type { LocalSaleRepository } from '../repositories/localSale.repository'
import type { LocalStockRepository } from '../repositories/localStock.repository'
import type { OwnerTuple, SaleAttemptRepository } from '../repositories/saleAttempt.repository'
import type { StockAllocationRepository } from '../repositories/stockAllocation.repository'
import type { OfflineSaleAuthorityRepository } from '../repositories/offlineSaleAuthority.repository'
import type { SyncQueueRepository } from '../repositories/syncQueue.repository'
import type { CatalogService } from './catalog.service'
import type { CommercialAccessService } from './commercialAccess.service'
import {
  originContextFingerprint,
  payloadHash,
  quantityToMilli,
  semanticIntentFingerprint,
  type SemanticIntentInput
} from './localSale.fingerprint'
import { buildUploadPayload } from './localSale.payload'
import type { ShiftAuthorityContext, ShiftAuthorityService } from './shiftAuthority.service'
import type { ShiftAuthority } from './shiftAuthority.service'
import type { StockAllocationService } from './stockAllocation.service'

const MAX_UNACKNOWLEDGED_PAGE_SIZE = 50
const DEFAULT_UNACKNOWLEDGED_PAGE_SIZE = 20

/**
 * Plan §1.8/§2.4: an environment/authority precondition (steps 1-6 of the business transaction —
 * commercial access, `pos.sell`, current shift/branch/warehouse identity, catalog revision) failing
 * is never a T3 rejection. The attempt remains `claimed` with zero writes so the exact stored intent
 * can be retried once the precondition is true again, or explicitly abandoned under D1-A. Only
 * content-driven failures resolved against the current catalog (calculateCart/calculatePayments,
 * step 7-8) or stock allocation (step 9) are definite T3 rejections requiring a new key.
 */
const NON_TERMINAL_FAILURE_CODES: ReadonlySet<LocalSaleFailure> = new Set([
  'permission-denied',
  'shift-unavailable',
  'shift-not-open',
  'shift-none',
  'shift-reconciliation-required',
  'shift-observation-foreign',
  'shift-observation-unknown',
  'workstation-unassigned',
  'allocation-data-unavailable',
  // CP-5D-C: the server's answer to an exact-deficit allocation request could not be established
  // (ambiguous transport, malformed success body, idempotency conflict, or a failed atomic local
  // persist). Laravel may or may not hold a grant under this attempt's derived key, so the attempt
  // must stay claimed and be replayed under that same key — never rejected into a new one.
  'allocation-acquisition-unresolved',
  'context-changed',
  'refresh-required'
])

export type LocalSaleFailure =
  | 'invalid-request'
  | 'permission-denied'
  | 'shift-unavailable'
  | 'shift-not-open'
  | 'shift-none'
  | 'shift-reconciliation-required'
  | 'shift-observation-foreign'
  | 'shift-observation-unknown'
  | 'workstation-unassigned'
  | 'refresh-required'
  | 'context-changed'
  | 'allocation-data-unavailable'
  | 'stock-allocation-unavailable'
  | 'allocation-acquisition-unresolved'
  | 'attempt-blocked'
  | 'attempt-conflict'
  | 'attempt-key-unavailable'
  | 'not-found'
  | 'already-committed'
  | 'attempt-unresolved'
  | 'integrity-inconsistency'
  | 'policy-blocked'

export interface LocalSaleRejected {
  readonly outcome: 'rejected'
  readonly attemptKey: string
  readonly failureCode: string
  readonly affectedLineIds?: readonly string[]
}

export interface LocalSaleCommitted {
  readonly outcome: 'committed'
  readonly attemptKey: string
  readonly invoice: LocalInvoiceRow
  readonly items: readonly LocalInvoiceItemRow[]
  readonly payments: readonly LocalInvoicePaymentRow[]
  readonly replay: boolean
}

export interface LocalSaleAcknowledged {
  readonly outcome: 'acknowledged'
  readonly attemptKey: string
  readonly invoice: LocalInvoiceRow
  readonly items: readonly LocalInvoiceItemRow[]
  readonly payments: readonly LocalInvoicePaymentRow[]
  readonly replay: boolean
}

export interface LocalSaleAbandoned {
  readonly outcome: 'abandoned'
  readonly attemptKey: string
}

export interface LocalSaleFailed {
  readonly outcome: 'failed'
  readonly code: LocalSaleFailure
  readonly attemptKey: string | null
  readonly blockingAttemptKey?: string
}

export type LocalSaleOutcome =
  | LocalSaleCommitted
  | LocalSaleRejected
  | LocalSaleAcknowledged
  | LocalSaleAbandoned
  | LocalSaleFailed

/**
 * CP-5D-C: the boundary at which a durable attempt row exists and its canonical intent has been
 * re-verified, but **no** invoice, payment, stock, allocation-consumption, or queue write has begun.
 * `AllocationAcquisitionService` runs exactly here — after the replay-stable attempt identity is
 * durable, and before the single business transaction that repeats every authoritative guard.
 */
export type PreparedSale =
  | { readonly kind: 'settled'; readonly outcome: LocalSaleOutcome }
  | {
      readonly kind: 'ready'
      readonly claimed: SaleAttemptRow
      readonly intent: CheckoutIntent
    }

export interface PendingAttemptsResult {
  readonly blockingAttempt: SaleAttemptRow | null
  readonly unacknowledgedResults: readonly SaleAttemptRow[]
  readonly nextCursor: { readonly committedAt: string; readonly attemptKey: string } | null
}

export interface LocalSaleDependencies {
  readonly database: SqliteDatabase
  readonly saleAttempts: SaleAttemptRepository
  readonly localSale: LocalSaleRepository
  readonly localStock: LocalStockRepository
  readonly stockAllocations: StockAllocationRepository
  readonly allocationService: StockAllocationService
  readonly commercialAccess: Pick<CommercialAccessService, 'assertAllowed' | 'evaluate'>
  readonly permissions: { hasPermission(permission: string): boolean }
  readonly shiftAuthority: Pick<ShiftAuthorityService, 'resolveForSell'> & {
    captureContext(): ShiftAuthorityContext
  }
  readonly bootstrapSnapshot: Pick<BootstrapSnapshotRepository, 'getBranch' | 'getWarehouse'>
  readonly catalog: Pick<CatalogService, 'resolveForSale'>
  readonly connectivity: { getSnapshot(): ConnectivitySnapshot }
  readonly syncQueue: Pick<SyncQueueRepository, 'enqueue' | 'invoiceUploadRowsFor'>
  /**
   * PS4 §6.2: the store of server-issued offline-sale authorities.
   *
   * Optional so an older wiring (and every existing test) keeps compiling and behaving identically:
   * with no repository there is no authority, so the commit path takes the legacy branch exactly as
   * it does today. Absence must mean legacy, never "assume permitted".
   */
  readonly offlineSaleAuthorities?: Pick<OfflineSaleAuthorityRepository, 'findUsable'>
  readonly now?: () => Date
  readonly createUuid?: () => string
}

interface ResolvedOrigin {
  readonly owner: OwnerTuple
  readonly claimSessionEpoch: number
  readonly shiftUuid: string
  readonly shiftObservedAt: string
  readonly branchUuid: string
  readonly warehouseUuid: string
}

function shiftFailureCode(
  authority: Exclude<ShiftAuthority, { readonly kind: 'open' }>
): LocalSaleFailure {
  switch (authority.kind) {
    case 'not-open':
      return 'shift-not-open'
    case 'none':
      return 'shift-none'
    case 'reconciliation-required':
      return 'shift-reconciliation-required'
    case 'foreign':
      return 'shift-observation-foreign'
    case 'unknown':
      return 'shift-observation-unknown'
  }
}

/**
 * Plan §D3-A: main normalizes connectivity at commit time. `unknown` is never proven online.
 */
function connectivityAtSale(snapshot: ConnectivitySnapshot): {
  readonly state: 'online' | 'offline' | 'unknown'
  readonly soldWhileOffline: boolean
} {
  if (snapshot.status === 'online') {
    return { state: 'online', soldWhileOffline: false }
  }

  if (snapshot.status === 'offline' || snapshot.status === 'backend_unreachable') {
    return { state: 'offline', soldWhileOffline: true }
  }

  return { state: 'unknown', soldWhileOffline: true }
}

/**
 * Plan §1/§2 (revision 3): the atomic local-sale state machine and business transaction. This
 * class is the only writer of `sale_attempts`/`local_invoices`/`local_invoice_items`/
 * `local_invoice_payments`/`local_stock_movements`/`local_stock_allocation_consumptions`/
 * `sync_queue` for a completed sale — every write happens inside one synchronous
 * `database.transaction()` call so concurrent completion calls cannot interleave (this app has one
 * main process, one better-sqlite3 handle, a fully synchronous API — plan §1.7).
 *
 * Never trusts renderer-supplied prices, tax values/revisions, totals, attribution, hashes,
 * allocation ownership, or a prior preview's "valid" outcome as authority. Every one of those is
 * re-resolved from main-owned state inside the business transaction below.
 */
export class LocalSaleService {
  private readonly now: () => Date
  private readonly createUuid: () => string

  constructor(private readonly dependencies: LocalSaleDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.createUuid = dependencies.createUuid ?? randomUUID
  }

  /** Main-generated identity for a genuinely new semantic intent (plan CP-4: "one main-generated
   * attempt key per submitted semantic intent"). The caller (CP-3's IPC layer) obtains this once
   * and resubmits it on every retry/acknowledge/abandon call for the same intent. */
  beginAttemptKey(): string {
    return this.createUuid()
  }

  /**
   * `checkout:complete`. Dispatches the existing state for `attemptKey` before considering
   * creation (plan §1.1/§2.3); a genuinely new key only proceeds through T1→(business txn)→T2/T3
   * after every creation gate passes.
   */
  complete(attemptKey: string, intent: CheckoutIntent): LocalSaleOutcome {
    return this.settle(this.prepareCompletion(attemptKey, intent))
  }

  /**
   * The claim/resolve half of `complete()`. Split out so the async completion orchestrator can
   * acquire missing allocation between the durable claim and the business transaction; calling
   * `prepareCompletion()` then `runPrepared()` is exactly equivalent to calling `complete()`.
   */
  prepareCompletion(attemptKey: string, intent: CheckoutIntent): PreparedSale {
    let context: ShiftAuthorityContext
    try {
      context = this.dependencies.shiftAuthority.captureContext()
    } catch {
      return this.settledFailure('policy-blocked')
    }

    const existing = this.dependencies.saleAttempts.findByKeyForOwner(attemptKey, context)

    if (existing) {
      return this.dispatchExisting(existing, intent)
    }

    return this.createNew(attemptKey, context, intent)
  }

  /** `checkout:retry-attempt` (T4): key-only, from the retained stored intent. */
  retry(attemptKey: string): LocalSaleOutcome {
    return this.settle(this.prepareRetry(attemptKey))
  }

  /** The resolve half of `retry()` (T4), from the retained stored intent only. */
  prepareRetry(attemptKey: string): PreparedSale {
    let owner: OwnerTuple
    try {
      owner = this.dependencies.shiftAuthority.captureContext()
    } catch {
      return this.settledFailure('policy-blocked')
    }

    const existing = this.dependencies.saleAttempts.findByKeyForOwner(attemptKey, owner)

    if (!existing) {
      return this.settledFailure('not-found')
    }

    if (existing.state !== 'claimed') {
      return { kind: 'settled', outcome: this.replayTerminal(existing) }
    }

    return this.resolvePrepared(existing, null)
  }

  /** `checkout:abandon-attempt` (T5, D1-A): no `pos.sell`, no open shift, no commercial access
   * required — only authentication/binding/owner and §1.7 no-sale evidence. */
  abandon(attemptKey: string): LocalSaleOutcome {
    let owner: OwnerTuple
    try {
      owner = this.dependencies.shiftAuthority.captureContext()
    } catch {
      return { outcome: 'failed', code: 'policy-blocked', attemptKey: null }
    }

    const existing = this.dependencies.saleAttempts.findByKeyForOwner(attemptKey, owner)

    if (!existing) {
      return { outcome: 'failed', code: 'not-found', attemptKey: null }
    }

    if (existing.state !== 'claimed') {
      return existing.state === 'committed' || existing.state === 'acknowledged'
        ? { outcome: 'failed', code: 'already-committed', attemptKey }
        : this.replayTerminal(existing)
    }

    // §1.7: two independent local witnesses that no sale committed for this claimed row.
    if (existing.invoiceLocalUuid !== null) {
      return { outcome: 'failed', code: 'integrity-inconsistency', attemptKey }
    }
    const linkedInvoice = this.dependencies.localSale.findInvoiceByAttemptKey(attemptKey)
    if (linkedInvoice !== null) {
      return { outcome: 'failed', code: 'integrity-inconsistency', attemptKey }
    }

    this.dependencies.saleAttempts.markAbandoned(attemptKey, this.now().toISOString())

    return { outcome: 'abandoned', attemptKey }
  }

  /** `checkout:acknowledge-attempt` (T7/T8): D1-A, no `pos.sell` required; idempotent. */
  acknowledge(attemptKey: string): LocalSaleOutcome {
    let owner: OwnerTuple
    try {
      owner = this.dependencies.shiftAuthority.captureContext()
    } catch {
      return { outcome: 'failed', code: 'policy-blocked', attemptKey: null }
    }

    const existing = this.dependencies.saleAttempts.findByKeyForOwner(attemptKey, owner)

    if (!existing) {
      return { outcome: 'failed', code: 'not-found', attemptKey: null }
    }

    if (existing.state === 'claimed') {
      return { outcome: 'failed', code: 'attempt-unresolved', attemptKey }
    }

    if (existing.state === 'rejected' || existing.state === 'abandoned') {
      return { outcome: 'failed', code: 'already-committed', attemptKey }
    }

    const result = this.requireResultIntegrity(existing)
    if (!result) {
      return { outcome: 'failed', code: 'integrity-inconsistency', attemptKey }
    }

    if (existing.state === 'committed') {
      this.dependencies.saleAttempts.markAcknowledged(attemptKey, this.now().toISOString())
    }

    return {
      outcome: 'acknowledged',
      attemptKey,
      ...result,
      replay: existing.state === 'acknowledged'
    }
  }

  /** `checkout:pending-attempts` (read-only discovery; never mutates). */
  pendingAttempts(
    limit = DEFAULT_UNACKNOWLEDGED_PAGE_SIZE,
    after: { readonly committedAt: string; readonly attemptKey: string } | null = null
  ): PendingAttemptsResult {
    const owner = this.dependencies.shiftAuthority.captureContext()
    const boundedLimit = Math.min(Math.max(limit, 1), MAX_UNACKNOWLEDGED_PAGE_SIZE)
    const blockingAttempt = this.dependencies.saleAttempts.findBlockingForOwner(owner)
    // Fetch one extra row to know whether another page remains.
    const rows = this.dependencies.saleAttempts.listUnacknowledgedCommittedForOwner(
      owner,
      boundedLimit + 1,
      after
    )
    const page = rows.slice(0, boundedLimit)
    const nextCursor =
      rows.length > boundedLimit && page.length > 0
        ? {
            committedAt: page[page.length - 1].committedAt as string,
            attemptKey: page[page.length - 1].attemptKey
          }
        : null

    return { blockingAttempt, unacknowledgedResults: page, nextCursor }
  }

  // --- existing-state dispatch (plan §2.3) -----------------------------------------------------

  private dispatchExisting(existing: SaleAttemptRow, intent: CheckoutIntent): PreparedSale {
    const owner: OwnerTuple = {
      companyUuid: existing.companyUuid,
      deviceUuid: existing.deviceUuid,
      userUuid: existing.userUuid
    }
    const incomingFingerprint = semanticIntentFingerprint(fingerprintInputFor(owner, intent))

    if (incomingFingerprint !== existing.intentFingerprint) {
      return this.settledFailure('attempt-conflict', existing.attemptKey)
    }

    if (existing.state === 'claimed') {
      return this.resolvePrepared(existing, intent)
    }

    return { kind: 'settled', outcome: this.replayTerminal(existing) }
  }

  private replayTerminal(existing: SaleAttemptRow): LocalSaleOutcome {
    if (existing.state === 'rejected') {
      return {
        outcome: 'rejected',
        attemptKey: existing.attemptKey,
        failureCode: existing.failureCode ?? 'unexpected'
      }
    }

    if (existing.state === 'abandoned') {
      return { outcome: 'abandoned', attemptKey: existing.attemptKey }
    }

    const result = this.requireResultIntegrity(existing)
    if (!result) {
      return { outcome: 'failed', code: 'integrity-inconsistency', attemptKey: existing.attemptKey }
    }

    return existing.state === 'acknowledged'
      ? { outcome: 'acknowledged', attemptKey: existing.attemptKey, ...result, replay: true }
      : { outcome: 'committed', attemptKey: existing.attemptKey, ...result, replay: true }
  }

  /** T6/T8 integrity check: the linkage between the attempt and its immutable result must agree. */
  private requireResultIntegrity(existing: SaleAttemptRow): {
    readonly invoice: LocalInvoiceRow
    readonly items: readonly LocalInvoiceItemRow[]
    readonly payments: readonly LocalInvoicePaymentRow[]
  } | null {
    if (existing.invoiceLocalUuid === null) {
      return null
    }

    const invoice = this.dependencies.localSale.findInvoiceByLocalUuid(existing.invoiceLocalUuid)

    if (!invoice || invoice.attemptKey !== existing.attemptKey) {
      return null
    }

    const items = this.dependencies.localSale.itemsForInvoice(invoice.localUuid)
    const payments = this.dependencies.localSale.paymentsForInvoice(invoice.localUuid)

    // Plan §1.6 item 3: a committed result is only replayable once the *whole* immutable result is
    // re-verified — not merely the attempt↔invoice linkage. A committed sale always has at least
    // one item and one payment (the calculator rejects an empty cart and an untendered total), so
    // an empty set here is a truncated result, not a legitimate shape.
    if (items.length === 0 || payments.length === 0) {
      return null
    }

    // Exactly one invoice/upload queue row, its stored payload never mutated, and the payload
    // still reconstructible byte-for-byte from the immutable rows themselves.
    const queued = this.dependencies.syncQueue.invoiceUploadRowsFor(invoice.localUuid)
    if (queued.length !== 1) {
      return null
    }

    const reconstructed = this.reconstructPayloadJson(invoice)
    if (
      reconstructed === null ||
      reconstructed !== queued[0].payloadJson ||
      payloadHash(JSON.parse(queued[0].payloadJson)) !== queued[0].payloadHash
    ) {
      return null
    }

    return { invoice, items, payments }
  }

  /**
   * Rebuilds the v2 wire payload for one invoice from its committed rows alone — the shared engine
   * behind post-write invariant 18 ("the v2 payload reconstructed from rows is byte-identical to
   * stored `payload_json`") and the committed-result integrity check of plan §1.6 item 3.
   *
   * Returns `null` when a consumption references a grant that no longer exists or the payload
   * cannot be built: that is an integrity failure to be reported, never a reason to silently emit
   * a payload missing an allocation proof.
   */
  private reconstructPayloadJson(invoice: LocalInvoiceRow): string | null {
    const items = this.dependencies.localSale.itemsForInvoice(invoice.localUuid)
    const payments = this.dependencies.localSale.paymentsForInvoice(invoice.localUuid)
    const consumptions = this.dependencies.stockAllocations.consumptionsForInvoice(
      invoice.localUuid
    )
    const consumptionsByItem = new Map<string, LocalStockAllocationConsumptionRow[]>()
    const grants = new Map<string, StockAllocationGrantRow>()

    for (const consumption of consumptions) {
      const list = consumptionsByItem.get(consumption.itemLocalUuid) ?? []
      list.push(consumption)
      consumptionsByItem.set(consumption.itemLocalUuid, list)

      if (!grants.has(consumption.allocationUuid)) {
        const grant = this.dependencies.stockAllocations.findGrantByUuid(consumption.allocationUuid)
        if (!grant) {
          return null
        }
        grants.set(consumption.allocationUuid, grant)
      }
    }

    try {
      return JSON.stringify(
        buildUploadPayload(invoice, items, payments, consumptionsByItem, grants)
      )
    } catch {
      return null
    }
  }

  // --- T1: genuinely new claim ------------------------------------------------------------------

  private createNew(
    attemptKey: string,
    context: ShiftAuthorityContext,
    intent: CheckoutIntent
  ): PreparedSale {
    const owner: OwnerTuple = context
    if (!this.dependencies.commercialAccess.evaluate('sell').allowed) {
      return this.settledFailure('context-changed')
    }

    if (!this.dependencies.permissions.hasPermission('pos.sell')) {
      return this.settledFailure('permission-denied')
    }

    const blocking = this.dependencies.saleAttempts.findBlockingForOwner(owner)
    if (blocking) {
      return {
        kind: 'settled',
        outcome: {
          outcome: 'failed',
          code: 'attempt-blocked',
          attemptKey: null,
          blockingAttemptKey: blocking.attemptKey
        }
      }
    }

    const shift = this.dependencies.shiftAuthority.resolveForSell()
    if (shift.kind !== 'open') {
      return this.settledFailure(shiftFailureCode(shift))
    }

    const branch = this.dependencies.bootstrapSnapshot.getBranch()
    const warehouse = this.dependencies.bootstrapSnapshot.getWarehouse()
    if (!branch || !warehouse) {
      return this.settledFailure('workstation-unassigned')
    }

    const claimSessionEpoch = context.sessionEpoch
    const origin: ResolvedOrigin = {
      owner,
      claimSessionEpoch,
      shiftUuid: shift.shiftUuid,
      shiftObservedAt: shift.observedAt,
      branchUuid: branch.branchUuid,
      warehouseUuid: warehouse.warehouseUuid
    }

    const intentFingerprint = semanticIntentFingerprint(fingerprintInputFor(owner, intent))
    const originFingerprint = originContextFingerprint({
      companyUuid: owner.companyUuid,
      deviceUuid: owner.deviceUuid,
      userUuid: owner.userUuid,
      originShiftUuid: origin.shiftUuid,
      originShiftObservedAt: origin.shiftObservedAt,
      originBranchUuid: origin.branchUuid,
      originWarehouseUuid: origin.warehouseUuid
    })
    const intentJson = JSON.stringify(intent)

    if (Buffer.byteLength(intentJson, 'utf8') > 65_536) {
      return this.settledFailure('invalid-request')
    }

    let claimed: SaleAttemptRow
    try {
      claimed = this.dependencies.saleAttempts.claim({
        attemptKey,
        ...owner,
        claimSessionEpoch: origin.claimSessionEpoch,
        originShiftUuid: origin.shiftUuid,
        originShiftObservedAt: origin.shiftObservedAt,
        originBranchUuid: origin.branchUuid,
        originWarehouseUuid: origin.warehouseUuid,
        originContextFingerprint: originFingerprint,
        intentFingerprint,
        intentVersion: 1,
        intentJson
      })
    } catch {
      // Primary-key or partial-unique-index collision — opaque per plan §1.1, no owner/state leak.
      return this.settledFailure('attempt-key-unavailable')
    }

    return this.resolvePrepared(claimed, intent)
  }

  // --- the single atomic business transaction (plan "Transaction sequence") ---------------------

  /** Runs a `PreparedSale` to its outcome; a settled preparation is already its own outcome. */
  private settle(prepared: PreparedSale): LocalSaleOutcome {
    return prepared.kind === 'settled' ? prepared.outcome : this.runPrepared(prepared)
  }

  private settledFailure(code: LocalSaleFailure, attemptKey: string | null = null): PreparedSale {
    return { kind: 'settled', outcome: { outcome: 'failed', code, attemptKey } }
  }

  /**
   * Re-verifies the canonical intent and immutable origin of a claimed attempt. Read-only: it makes
   * no business write, which is what lets an allocation acquisition safely run between it and
   * `runPrepared()`.
   */
  private resolvePrepared(
    claimed: SaleAttemptRow,
    suppliedIntent: CheckoutIntent | null
  ): PreparedSale {
    const owner: OwnerTuple = {
      companyUuid: claimed.companyUuid,
      deviceUuid: claimed.deviceUuid,
      userUuid: claimed.userUuid
    }

    let intent: CheckoutIntent
    if (suppliedIntent) {
      intent = suppliedIntent
    } else {
      if (claimed.intentJson === null) {
        return this.settledFailure('integrity-inconsistency', claimed.attemptKey)
      }
      try {
        intent = JSON.parse(claimed.intentJson) as CheckoutIntent
      } catch {
        return this.settledFailure('integrity-inconsistency', claimed.attemptKey)
      }
    }

    const recomputedIntentFingerprint = semanticIntentFingerprint(
      fingerprintInputFor(owner, intent)
    )
    if (recomputedIntentFingerprint !== claimed.intentFingerprint) {
      return this.settledFailure('integrity-inconsistency', claimed.attemptKey)
    }

    const recomputedOriginFingerprint = originContextFingerprint({
      companyUuid: claimed.companyUuid,
      deviceUuid: claimed.deviceUuid,
      userUuid: claimed.userUuid,
      originShiftUuid: claimed.originShiftUuid,
      originShiftObservedAt: claimed.originShiftObservedAt,
      originBranchUuid: claimed.originBranchUuid,
      originWarehouseUuid: claimed.originWarehouseUuid
    })
    if (recomputedOriginFingerprint !== claimed.originContextFingerprint) {
      return this.settledFailure('integrity-inconsistency', claimed.attemptKey)
    }

    return { kind: 'ready', claimed, intent }
  }

  /**
   * The single atomic business transaction for an already-prepared attempt. Every authoritative
   * guard — commercial access, `pos.sell`, shift/branch/warehouse identity, catalog revision,
   * calculation, and the allocation split re-read from SQLite — is repeated here, so nothing an
   * allocation acquisition observed beforehand is trusted as authority.
   */
  runPrepared(prepared: Extract<PreparedSale, { kind: 'ready' }>): LocalSaleOutcome {
    const { claimed, intent } = prepared
    const owner: OwnerTuple = {
      companyUuid: claimed.companyUuid,
      deviceUuid: claimed.deviceUuid,
      userUuid: claimed.userUuid
    }

    let result:
      | {
          readonly ok: true
          readonly invoice: LocalInvoiceRow
          readonly items: readonly LocalInvoiceItemRow[]
          readonly payments: readonly LocalInvoicePaymentRow[]
        }
      | {
          readonly ok: false
          readonly code: LocalSaleFailure
          readonly affectedLineIds?: readonly string[]
        }
    try {
      // BH-04B-3: `BEGIN IMMEDIATE` with restart-on-contention. `runBusinessTransaction` re-reads
      // eligibility, the accepted coverage boundary and local consumption itself, so a restart
      // re-derives the whole decision instead of committing one computed before write authority was
      // held. See `runSerializedWrite` for why the deferred begin was not sufficient at the
      // database boundary, even though one process happens to be safe today.
      result = runSerializedWrite(this.dependencies.database, () =>
        this.runBusinessTransaction(claimed, owner, intent)
      )
    } catch (error) {
      if (isStorageFailure(error)) {
        // Plan §2.4: a storage failure (disk full, SQLITE_BUSY, I/O) leaves no state change — the
        // row stays claimed, the safe direction. The caller sees a typed transport failure.
        throw error
      }

      // Plan §2.4: a post-write invariant/constraint violation inside the business transaction is
      // a definite (if unexpected) rejection, recorded as T3 with failure_code='invariant' — never
      // left dangling as an ordinary thrown error.
      this.recordRejection(claimed.attemptKey, 'invariant', this.now().toISOString())
      return { outcome: 'rejected', attemptKey: claimed.attemptKey, failureCode: 'invariant' }
    }

    if (!result.ok) {
      if (NON_TERMINAL_FAILURE_CODES.has(result.code)) {
        // Plan §1.8: precondition failures never rewrite the row — it stays `claimed`, retryable
        // once true again, or explicitly abandonable under D1-A. Zero writes, no T3.
        return { outcome: 'failed', code: result.code, attemptKey: claimed.attemptKey }
      }
      this.recordRejection(claimed.attemptKey, result.code, this.now().toISOString())
      return {
        outcome: 'rejected',
        attemptKey: claimed.attemptKey,
        failureCode: result.code,
        ...(result.affectedLineIds ? { affectedLineIds: result.affectedLineIds } : {})
      }
    }

    return {
      outcome: 'committed',
      attemptKey: claimed.attemptKey,
      invoice: result.invoice,
      items: result.items,
      payments: result.payments,
      replay: false
    }
  }

  /**
   * The tracked lines of a prepared attempt, resolved through the **same** company-scoped,
   * single-snapshot catalog resolver the business transaction uses. Tracking comes from the resolved
   * `trackStock` contract flag, never from whether a renderer line happens to carry a stock value.
   *
   * Returns an empty list whenever the catalog cannot authoritatively answer (unreadable catalog,
   * unresolvable line, or a moved contract revision). That deliberately suppresses any allocation
   * request: the business transaction is the one place allowed to turn those into `refresh-required`.
   */
  trackedDemand(prepared: Extract<PreparedSale, { kind: 'ready' }>): readonly {
    readonly lineId: string
    readonly productUuid: string
    readonly requiredMilli: number
  }[] {
    const { intent } = prepared

    let resolution: ReturnType<CatalogService['resolveForSale']>
    try {
      resolution = this.dependencies.catalog.resolveForSale({
        productUuids: intent.items.map((item) => item.productUuid),
        paymentMethodUuids: intent.payments.map((payment) => payment.paymentMethodUuid),
        customerUuid: intent.customerUuid
      })
    } catch {
      return []
    }

    if (!resolution || resolution.contract.revision !== intent.catalogRevision) {
      return []
    }

    const productsByUuid = new Map(resolution.products.map((product) => [product.uuid, product]))

    return intent.items.flatMap((item) => {
      const product = productsByUuid.get(item.productUuid)

      return product?.trackStock === true
        ? [
            {
              lineId: item.id,
              productUuid: product.uuid,
              requiredMilli: quantityToMilli(item.quantity)
            }
          ]
        : []
    })
  }

  private recordRejection(attemptKey: string, failureCode: string, rejectedAt: string): void {
    try {
      this.dependencies.saleAttempts.markRejected(attemptKey, failureCode, rejectedAt)
    } catch {
      // T3 recording failure: the row remains claimed with its retained intent — the safe
      // direction (plan §2.4/§2.9 transaction sequence R1).
    }
  }

  private runBusinessTransaction(
    claimed: SaleAttemptRow,
    owner: OwnerTuple,
    intent: CheckoutIntent
  ):
    | {
        readonly ok: true
        readonly invoice: LocalInvoiceRow
        readonly items: readonly LocalInvoiceItemRow[]
        readonly payments: readonly LocalInvoicePaymentRow[]
      }
    | {
        readonly ok: false
        readonly code: LocalSaleFailure
        readonly affectedLineIds?: readonly string[]
      } {
    // Capture the authoritative current session at the business boundary. The claim epoch is
    // immutable audit evidence; only this main-owned current epoch may describe the actual commit.
    // `captureContext()` also repeats authenticated/active user, company, and bound-device guards.
    let commitContext: ShiftAuthorityContext
    try {
      commitContext = this.dependencies.shiftAuthority.captureContext()
    } catch {
      return { ok: false, code: 'policy-blocked' }
    }
    if (
      commitContext.companyUuid !== owner.companyUuid ||
      commitContext.deviceUuid !== owner.deviceUuid ||
      commitContext.userUuid !== owner.userUuid
    ) {
      return { ok: false, code: 'context-changed' }
    }

    // 2. commercialAccess.assertAllowed('sell'); require pos.sell.
    if (!this.dependencies.commercialAccess.evaluate('sell').allowed) {
      return { ok: false, code: 'context-changed' }
    }
    if (!this.dependencies.permissions.hasPermission('pos.sell')) {
      return { ok: false, code: 'permission-denied' }
    }

    // 3-4. Current shift/branch/warehouse must equal the captured origin exactly. The individual
    // authority arms remain visible to the cashier, but all deny in main before a write; a changed
    // open context is `context-changed` and is never silently re-attributed to a new shift.
    const currentShift = this.dependencies.shiftAuthority.resolveForSell()
    if (currentShift.kind !== 'open') {
      return { ok: false, code: shiftFailureCode(currentShift) }
    }
    const currentBranch = this.dependencies.bootstrapSnapshot.getBranch()
    const currentWarehouse = this.dependencies.bootstrapSnapshot.getWarehouse()
    if (!currentBranch || !currentWarehouse) {
      return { ok: false, code: 'workstation-unassigned' }
    }
    if (
      currentShift.shiftUuid !== claimed.originShiftUuid ||
      currentBranch.branchUuid !== claimed.originBranchUuid ||
      currentWarehouse.warehouseUuid !== claimed.originWarehouseUuid
    ) {
      return { ok: false, code: 'context-changed' }
    }

    // 5-6. resolveForSale, require the resolved contract revision matches the intent's.
    //
    // `resolveForSale` (not `resolveForCheckout`) additionally requires the issued contract to be
    // inside its own `[generatedAt, validUntil)` window under the trusted clock. Revision equality
    // alone never proved that: an expired snapshot keeps its revision, so a stale catalog satisfied
    // the old comparison and the sale committed — then failed at upload, where the backend enforces
    // `generated_at <= sold_at < valid_until`. Re-resolving *here*, inside the serialized business
    // transaction and before any business write, is also what makes the boundary safe for a draft
    // that was started while the contract was still current: crossing `validUntil` mid-checkout
    // rolls the transaction back with zero writes rather than committing an unsyncable sale.
    const resolutionInput: CheckoutResolutionInput = {
      productUuids: intent.items.map((item) => item.productUuid),
      paymentMethodUuids: intent.payments.map((payment) => payment.paymentMethodUuid),
      customerUuid: intent.customerUuid
    }
    const resolution = this.dependencies.catalog.resolveForSale(resolutionInput)
    if (!resolution || resolution.contract.revision !== intent.catalogRevision) {
      return { ok: false, code: 'refresh-required' }
    }

    const productsByUuid = new Map(resolution.products.map((product) => [product.uuid, product]))

    // 7. calculateCart from RESOLVED rows only.
    const cart = calculateCart(
      intent.items.map((item) => {
        const product = productsByUuid.get(item.productUuid)
        if (!product) {
          throw new Error('resolveForSale returned an incomplete product set')
        }

        return {
          id: item.id,
          productUuid: item.productUuid,
          quantity: item.quantity,
          unitPriceAmount: product.price.amount,
          currency: product.price.currency,
          discountType: item.discountType,
          discountValue: item.discountValue,
          taxMode: product.tax.mode,
          taxRateBasisPoints: product.tax.rateBasisPoints
        }
      }),
      resolution.contract,
      intent.invoiceDiscount.discountType,
      intent.invoiceDiscount.discountValue
    )
    if (!cart.ok) {
      return { ok: false, code: 'invalid-request' }
    }

    // The catalog contract permits only `single_invoice_mode`, and calculateCart has just proven
    // the resolved lines uniform. Derive invoice metadata from that proven set so item order can
    // never select authority. Widening the policy requires a new backend upload contract version,
    // top-level representation, fixture, and migration; it is outside Phase 3F.
    const resolvedTaxModes = new Set(
      intent.items.flatMap((item) => {
        const mode = productsByUuid.get(item.productUuid)?.tax.mode
        return mode === undefined ? [] : [mode]
      })
    )
    if (resolvedTaxModes.size !== 1) {
      return { ok: false, code: 'invalid-request' }
    }
    const [invoiceTaxMode] = resolvedTaxModes
    if (invoiceTaxMode === undefined) {
      return { ok: false, code: 'invalid-request' }
    }

    // 8. calculatePayments from RESOLVED methods only.
    const resolvedMethods: readonly ResolvedPaymentMethod[] = resolution.paymentMethods.map(
      (method) => ({
        uuid: method.uuid,
        type: method.type,
        isActive: method.isActive,
        requiresReference: method.requiresReference,
        allowsChange: method.allowsChange
      })
    )
    const payments = calculatePayments(
      intent.payments.map((payment) => ({
        id: payment.id,
        methodUuid: payment.paymentMethodUuid,
        amount: payment.amount,
        reference: payment.reference
      })),
      resolvedMethods,
      cart.value.grandTotalAmount
    )
    if (!payments.ok) {
      return { ok: false, code: 'invalid-request' }
    }

    // 9. D3-A connectivity metadata; allocation split for every tracked line.
    const connectivity = connectivityAtSale(this.dependencies.connectivity.getSnapshot())
    const trackedIndexes = intent.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => productsByUuid.get(item.productUuid)?.trackStock === true)

    // PS4 §6.2/§7.1 — the ONLY thing that permits an uncovered remainder.
    //
    // Read from stored, server-issued state under the resolved owner and the trusted clock. It is
    // never inferred from cached stock, from connectivity, from the absence of grants, or from a
    // local flag: in this mode stock authorizes nothing, and an authority is the only thing that
    // does. A device that has never negotiated one gets `null` here and behaves exactly as today —
    // which is what makes this build safe to ship before any backend is configured.
    const offlineSaleAuthority =
      this.dependencies.offlineSaleAuthorities?.findUsable(
        owner.companyUuid,
        owner.deviceUuid,
        this.now().toISOString()
      ) ?? null

    const uncoveredMilliByIndex = new Map<number, number>()
    const splitsByIndex = new Map<
      number,
      readonly {
        allocationUuid: string
        rightsGeneration: number
        consumptionSequence: number
        localConsumptionUuid: string
        quantityMilli: number
      }[]
    >()
    const grantsByAllocationUuid = new Map<string, StockAllocationGrantRow>()

    for (const productUuid of new Set(trackedIndexes.map(({ item }) => item.productUuid))) {
      const linesForProduct = trackedIndexes.filter(({ item }) => item.productUuid === productUuid)
      const demands = linesForProduct.map(({ item }) => quantityToMilli(item.quantity))
      const split = this.dependencies.allocationService.splitForProduct(
        {
          companyUuid: owner.companyUuid,
          deviceUuid: owner.deviceUuid,
          warehouseUuid: claimed.originWarehouseUuid
        },
        productUuid,
        demands,
        this.now().toISOString(),
        offlineSaleAuthority !== null
      )

      if (!split.ok) {
        return {
          ok: false,
          code: split.code,
          affectedLineIds: linesForProduct.map(({ item }) => item.id)
        }
      }

      linesForProduct.forEach(({ index }, lineOffset) => {
        splitsByIndex.set(index, split.perLine[lineOffset])
        uncoveredMilliByIndex.set(index, split.uncoveredMilliByLine[lineOffset] ?? 0)
      })

      for (const grantUuid of new Set(split.perLine.flat().map((entry) => entry.allocationUuid))) {
        const grant = this.dependencies.stockAllocations.findGrantByUuid(grantUuid)
        if (grant) {
          grantsByAllocationUuid.set(grantUuid, grant)
        }
      }
    }

    // 10. one commit timestamp; D4-A local number.
    const committedAt = this.now().toISOString()
    const devicePrefix = owner.deviceUuid.replace(/-/g, '').slice(0, 6)
    const datePart = committedAt.slice(0, 10).replace(/-/g, '')
    const sequence = this.dependencies.localSale.nextOfflineSequenceForDay(devicePrefix, datePart)
    const offlineNumber = `POS-${devicePrefix}-${datePart}-${sequence.toString().padStart(6, '0')}`

    // 11. INSERT local_invoices.
    const invoiceLocalUuid = this.createUuid()
    const invoice = this.dependencies.localSale.insertInvoice({
      localUuid: invoiceLocalUuid,
      attemptKey: claimed.attemptKey,
      offlineNumber,
      companyUuid: owner.companyUuid,
      branchUuid: claimed.originBranchUuid,
      warehouseUuid: claimed.originWarehouseUuid,
      deviceUuid: owner.deviceUuid,
      userUuid: owner.userUuid,
      shiftUuid: claimed.originShiftUuid,
      commitSessionEpoch: commitContext.sessionEpoch,
      catalogRevision: resolution.contract.revision,
      intentFingerprint: claimed.intentFingerprint,
      customerUuid: intent.customerUuid,
      currency: resolution.contract.currency,
      currencyExponent: resolution.contract.currencyExponent,
      taxMode: invoiceTaxMode,
      invoiceDiscountType: intent.invoiceDiscount.discountType,
      invoiceDiscountValue:
        intent.invoiceDiscount.discountType === null ? 0 : intent.invoiceDiscount.discountValue,
      subtotalAmount: cart.value.subtotalAmount,
      discountTotalAmount: cart.value.discountTotalAmount,
      taxTotalAmount: cart.value.taxTotalAmount,
      grandTotalAmount: cart.value.grandTotalAmount,
      paidTotalAmount: payments.value.paidTotalAmount,
      changeDueAmount: payments.value.changeDueAmount,
      soldAt: committedAt,
      connectivityStateAtSale: connectivity.state,
      soldWhileOffline: connectivity.soldWhileOffline,
      notes: null,
      commercialSnapshotJson: JSON.stringify({ evaluatedAt: committedAt }),
      // PS4: recorded on the invoice, so the payload version is a property of the sale that was
      // actually rung rather than of the process that later uploads it.
      offlineSaleAuthorityUuid: offlineSaleAuthority?.authorityUuid ?? null,
      stockAuthorizationPolicy: offlineSaleAuthority === null ? null : 'physical_presence',
      createdAt: committedAt
    })

    // 12-15. one item + zero-or-more allocation consumptions + one movement per tracked line; one payment per row.
    const itemsByLocalUuid = new Map<string, string>()
    const plannedConsumptions: {
      readonly itemLocalUuid: string
      readonly lineIndex: number
      readonly entry: {
        readonly allocationUuid: string
        readonly rightsGeneration: number
        readonly consumptionSequence: number
        readonly localConsumptionUuid: string
        readonly quantityMilli: number
      }
    }[] = []
    intent.items.forEach((item, index) => {
      const product = productsByUuid.get(item.productUuid)
      if (!product) {
        throw new Error('resolveForSale returned an incomplete product set')
      }
      const line = cart.value.lines[index]
      const itemLocalUuid = this.createUuid()
      itemsByLocalUuid.set(item.id, itemLocalUuid)

      this.dependencies.localSale.insertItem({
        localUuid: itemLocalUuid,
        invoiceLocalUuid,
        lineIndex: index,
        productUuid: product.uuid,
        productName: product.name,
        sku: product.sku,
        barcode: product.barcode,
        unit: product.unit,
        trackStock: product.trackStock,
        quantityMilli: quantityToMilli(item.quantity),
        unitPriceAmount: product.price.amount,
        currency: product.price.currency,
        priceRevision: product.price.revision,
        taxUuid: product.tax.id,
        taxMode: product.tax.mode,
        taxRateBasisPoints: product.tax.rateBasisPoints,
        taxRevision: product.tax.revision,
        discountType: item.discountType,
        discountValue: item.discountType === null ? 0 : item.discountValue,
        subtotalAmount: line.subtotalAmount,
        discountAmount: line.discountAmount,
        taxAmount: line.taxAmount,
        totalAmount: line.totalAmount,
        // PS4 §8.4: the covered/uncovered split, recorded per line so it is recoverable from
        // committed rows alone. An untracked line is 0/0; a tracked line's two values sum to its
        // quantity, enforced by the table's conditional CHECK.
        allocationCoveredMilli: product.trackStock
          ? quantityToMilli(item.quantity) - (uncoveredMilliByIndex.get(index) ?? 0)
          : 0,
        uncoveredMilli: product.trackStock ? (uncoveredMilliByIndex.get(index) ?? 0) : 0,
        createdAt: committedAt
      })

      if (product.trackStock) {
        // BH-04B-3: the consumption rows are planned here but written after the upload payload
        // exists, because each row's journal-v1 entry binds the invoice request hash — which is a
        // hash of that payload. Nothing else about the order changes: the rows still commit inside
        // this same transaction, before any invariant check.
        for (const entry of splitsByIndex.get(index) ?? []) {
          plannedConsumptions.push({ itemLocalUuid, lineIndex: index, entry })
        }

        const uncoveredMilli = uncoveredMilliByIndex.get(index) ?? 0
        const coveredMilli = quantityToMilli(item.quantity) - uncoveredMilli

        this.dependencies.localStock.insertMovement({
          localUuid: this.createUuid(),
          invoiceLocalUuid,
          itemLocalUuid,
          productUuid: product.uuid,
          warehouseUuid: claimed.originWarehouseUuid,
          quantityMilli: quantityToMilli(item.quantity),
          stockAuthorization:
            uncoveredMilli <= 0 ? 'allocation' : coveredMilli > 0 ? 'mixed' : 'physical_presence',
          createdAt: committedAt
        })
      }
    })

    payments.value.rows.forEach((row, index) => {
      const method = resolution.paymentMethods.find(
        (candidate) => candidate.uuid === row.methodUuid
      )
      this.dependencies.localSale.insertPayment({
        localUuid: this.createUuid(),
        invoiceLocalUuid,
        paymentIndex: index,
        paymentMethodUuid: row.methodUuid,
        type: row.type,
        amount: row.amount,
        reference: row.reference,
        requiresReference: method?.requiresReference ?? false,
        paidAt: committedAt,
        methodSnapshotJson: JSON.stringify(method ?? {}),
        createdAt: committedAt
      })
    })

    // 16. INSERT sync_queue (guarded by the partial unique index).
    const items = this.dependencies.localSale.itemsForInvoice(invoiceLocalUuid)
    const paymentRows = this.dependencies.localSale.paymentsForInvoice(invoiceLocalUuid)
    const consumptionsByItem = new Map<string, LocalStockAllocationConsumptionRow[]>()
    for (const planned of plannedConsumptions) {
      const list = consumptionsByItem.get(planned.itemLocalUuid) ?? []
      list.push(plannedConsumptionRow(planned, invoiceLocalUuid, committedAt))
      consumptionsByItem.set(planned.itemLocalUuid, list)
    }
    // Payload order is semantic and deliberately independent of grant-selection order: it is
    // `(consumption_sequence, allocation_uuid)`, exactly what `consumptionsForInvoice()` returns.
    // Preserving it here matters because these bytes are hashed — by `payload_hash` locally and by
    // the backend's `request_hash`, which every journal entry below binds — so a payload whose array
    // order tracked insertion order would produce a different hash for the same sale.
    for (const list of consumptionsByItem.values()) {
      list.sort(
        (left, right) =>
          left.consumptionSequence - right.consumptionSequence ||
          left.allocationUuid.localeCompare(right.allocationUuid)
      )
    }
    const payload = buildUploadPayload(
      invoice,
      items,
      paymentRows,
      consumptionsByItem,
      grantsByAllocationUuid
    )
    const payloadJson = JSON.stringify(payload)

    // BH-04B-3: the exact hash the backend will compute for this frozen request body, bound into
    // every consumption's journal entry so the local chain can later be recomputed and checked
    // against a server coverage boundary. Computed from the committed payload — never from today's
    // catalog rows, and never from an upload response.
    const requestHash = invoiceRequestHash(payload)

    for (const planned of plannedConsumptions) {
      const { entry } = planned
      const previousChainHash =
        this.dependencies.stockAllocations.latestJournalChainHash(
          entry.allocationUuid,
          entry.rightsGeneration
        ) ?? allocationJournalInitialHash(entry.allocationUuid, entry.rightsGeneration)
      const itemLineUuid = allocationItemLineUuid(invoiceLocalUuid, planned.lineIndex)
      const journalEntry = {
        allocationUuid: entry.allocationUuid,
        rightsGeneration: entry.rightsGeneration,
        consumptionSequence: entry.consumptionSequence,
        localConsumptionUuid: entry.localConsumptionUuid,
        invoiceIdempotencyKey: invoiceLocalUuid,
        itemLineUuid,
        quantityMilli: entry.quantityMilli,
        requestHash
      }
      const hashes = allocationJournalAppend(previousChainHash, journalEntry)

      this.dependencies.stockAllocations.insertConsumption({
        localUuid: entry.localConsumptionUuid,
        allocationUuid: entry.allocationUuid,
        consumptionSequence: entry.consumptionSequence,
        invoiceLocalUuid,
        itemLocalUuid: planned.itemLocalUuid,
        quantityMilli: entry.quantityMilli,
        createdAt: committedAt,
        rightsGeneration: entry.rightsGeneration,
        invoiceIdempotencyKey: invoiceLocalUuid,
        itemLineUuid,
        requestHash,
        entryHash: hashes.entryHash,
        chainHash: hashes.chainHash
      })
    }
    this.dependencies.syncQueue.enqueue({
      localQueueUuid: this.createUuid(),
      aggregateType: 'invoice',
      localAggregateUuid: invoiceLocalUuid,
      operation: 'upload',
      payloadJson,
      payloadHash: payloadHash(payload),
      idempotencyKey: invoiceLocalUuid
    })

    // 17. UPDATE sale_attempts -> committed.
    this.dependencies.saleAttempts.markCommitted(claimed.attemptKey, invoiceLocalUuid, committedAt)

    // 18. post-write invariants — any failure throws and rolls the whole transaction back.
    this.assertPostWriteInvariants({
      claimed,
      owner,
      invoice,
      items,
      payments: paymentRows,
      expectedItemCount: intent.items.length,
      expectedPaymentCount: payments.value.rows.length,
      payloadJson,
      grants: grantsByAllocationUuid
    })

    return { ok: true, invoice, items, payments: paymentRows }
  }

  /**
   * Step 18 of the plan's transaction sequence, in full.
   *
   * These run *inside* the business transaction, so throwing here rolls back every write made by
   * this sale. Plan §5.2 is explicit that several of these are the service's job precisely because
   * the schema cannot express them: `UNIQUE(item_local_uuid)` bounds movements from above but
   * never guarantees that a tracked line *has* one, and no row-local CHECK can compare an
   * allocation-consumption sum to its line quantity or a queued payload to the rows it came from.
   */
  private assertPostWriteInvariants(context: {
    readonly claimed: SaleAttemptRow
    readonly owner: OwnerTuple
    readonly invoice: LocalInvoiceRow
    readonly items: readonly LocalInvoiceItemRow[]
    readonly payments: readonly LocalInvoicePaymentRow[]
    readonly expectedItemCount: number
    readonly expectedPaymentCount: number
    readonly payloadJson: string
    readonly grants: ReadonlyMap<string, StockAllocationGrantRow>
  }): void {
    const fail = (reason: string): never => {
      throw new Error(`Post-write invariant failed: ${reason}`)
    }

    const { claimed, invoice, items, payments } = context

    // Cardinality: exactly the rows this sale intended to write, no more and no fewer.
    if (items.length !== context.expectedItemCount) {
      fail('invoice item count does not match the submitted intent')
    }
    if (payments.length !== context.expectedPaymentCount) {
      fail('invoice payment count does not match the calculated tenders')
    }

    // Totals.
    if (items.reduce((sum, item) => sum + item.totalAmount, 0) !== invoice.grandTotalAmount) {
      fail('item totals do not sum to the grand total')
    }
    if (payments.reduce((sum, payment) => sum + payment.amount, 0) !== invoice.paidTotalAmount) {
      fail('payment amounts do not sum to the paid total')
    }
    // Phase 3F has no credit sales; the schema also pins this, and both must agree.
    if (invoice.dueAmount !== 0) {
      fail('a Phase 3F sale can never carry a due amount')
    }

    // Every row must join back to *this* invoice.
    if (items.some((item) => item.invoiceLocalUuid !== invoice.localUuid)) {
      fail('an invoice item belongs to a different invoice')
    }
    if (payments.some((payment) => payment.invoiceLocalUuid !== invoice.localUuid)) {
      fail('an invoice payment belongs to a different invoice')
    }
    if (items.some((item) => item.taxMode !== invoice.taxMode)) {
      fail('an invoice item tax mode differs from the proven uniform invoice tax mode')
    }

    const movements = this.dependencies.localStock.movementsForInvoice(invoice.localUuid)
    const consumptions = this.dependencies.stockAllocations.consumptionsForInvoice(
      invoice.localUuid
    )
    const trackedItems = items.filter((item) => item.trackStock)

    // One movement for every tracked line — both bounds, per plan §5.2.
    if (movements.length !== trackedItems.length) {
      fail('the stock movement count does not equal the tracked line count')
    }

    for (const item of items) {
      const itemMovements = movements.filter(
        (movement) => movement.itemLocalUuid === item.localUuid
      )
      const itemConsumptions = consumptions.filter(
        (consumption) => consumption.itemLocalUuid === item.localUuid
      )

      if (!item.trackStock) {
        // An untracked line consumes no allocation and moves no stock.
        if (itemMovements.length > 0) {
          fail('an untracked line produced a stock movement')
        }
        if (itemConsumptions.length > 0) {
          fail('an untracked line consumed allocation')
        }
        continue
      }

      if (itemMovements.length !== 1) {
        fail('a tracked line does not have exactly one stock movement')
      }
      const [movement] = itemMovements
      if (
        movement.productUuid !== item.productUuid ||
        movement.quantityMilli !== item.quantityMilli ||
        movement.warehouseUuid !== claimed.originWarehouseUuid
      ) {
        fail('a tracked line movement disagrees with its item or the origin warehouse')
      }

      // PS4 §12: TIGHTENED, not relaxed.
      //
      // The rule was "consumption covers the line exactly". It is now
      // `covered + uncovered === quantity_milli`, with `uncovered > 0` permitted ONLY under a stored
      // authority — which is strictly more than the old rule checked, because it also verifies that
      // the split recorded on the row agrees with the consumptions actually written.
      //
      // The authority clause is the load-bearing half. Without it a bug anywhere upstream could
      // commit an under-covered sale that the backend would terminally reject, and a frozen payload
      // can never be repaired: §12's invariant is that every successful local commit must ALREADY
      // contain its final, valid, immutable upload payload.
      const consumed = itemConsumptions.reduce((sum, entry) => sum + entry.quantityMilli, 0)

      if (consumed !== item.allocationCoveredMilli) {
        fail('the recorded allocation coverage disagrees with the consumptions actually written')
      }

      if (consumed + item.uncoveredMilli !== item.quantityMilli) {
        fail(
          'allocation coverage plus uncovered remainder does not equal the tracked line quantity'
        )
      }

      // Read from the COMMITTED invoice row, not from a value passed in: the invariant then proves
      // what was actually persisted rather than what the caller believed it intended.
      if (item.uncoveredMilli > 0 && invoice.offlineSaleAuthorityUuid === null) {
        fail('an uncovered remainder was committed without a stored offline-sale authority')
      }

      if (item.uncoveredMilli === 0 && itemConsumptions.length === 0) {
        fail('allocation consumption does not exactly cover its tracked line quantity')
      }

      for (const consumption of itemConsumptions) {
        const grant = context.grants.get(consumption.allocationUuid)

        // Every grant must belong to the immutable origin: this company, this device, this
        // warehouse, this product. There is no fallback to shared or cached stock (D2-B).
        if (
          !grant ||
          grant.companyUuid !== context.owner.companyUuid ||
          grant.deviceUuid !== context.owner.deviceUuid ||
          grant.warehouseUuid !== claimed.originWarehouseUuid ||
          grant.productUuid !== item.productUuid
        ) {
          fail('an allocation consumption references a grant outside the immutable origin')
        }
      }
    }

    if (
      consumptions.length === 0 &&
      trackedItems.length > 0 &&
      invoice.offlineSaleAuthorityUuid === null
    ) {
      // Still fatal in legacy mode. Under a stored authority a fully uncovered sale is the intended
      // outcome, and the per-line checks above have already proven the split adds up.
      fail('a tracked sale committed without any allocation consumption')
    }

    // Exactly one invoice/upload queue row, holding exactly the payload that was built, and that
    // payload must still be reconstructible byte-for-byte from the committed rows themselves.
    const queued = this.dependencies.syncQueue.invoiceUploadRowsFor(invoice.localUuid)
    if (queued.length !== 1) {
      fail('there is not exactly one invoice upload queue row')
    }
    if (queued[0].payloadJson !== context.payloadJson) {
      fail('the queued payload is not the payload that was built')
    }

    const reconstructed = this.reconstructPayloadJson(invoice)
    if (reconstructed === null || reconstructed !== context.payloadJson) {
      fail('the queued payload does not reconstruct byte-for-byte from the committed rows')
    }
  }
}

function fingerprintInputFor(owner: OwnerTuple, intent: CheckoutIntent): SemanticIntentInput {
  return {
    companyUuid: owner.companyUuid,
    deviceUuid: owner.deviceUuid,
    userUuid: owner.userUuid,
    catalogRevision: intent.catalogRevision,
    customerUuid: intent.customerUuid,
    items: intent.items.map((item) => ({
      productUuid: item.productUuid,
      quantity: item.quantity,
      discountType: item.discountType,
      discountValue: item.discountValue
    })),
    invoiceDiscountType: intent.invoiceDiscount.discountType,
    invoiceDiscountValue: intent.invoiceDiscount.discountValue,
    payments: intent.payments.map((payment) => ({
      paymentMethodUuid: payment.paymentMethodUuid,
      amount: payment.amount,
      reference: payment.reference
    })),
    notes: null
  }
}

/**
 * Distinguishes a genuine storage failure (SQLITE_BUSY/locked, disk I/O) — which must leave the
 * attempt `claimed` — from every other thrown error inside the business transaction (a violated
 * CHECK/FK/UNIQUE constraint, or an application-level invariant failure), which is a definite
 * rejection per plan §2.4.
 */
/**
 * BH-04B-3: the payload builder consumes committed consumption rows, but the journal evidence on a
 * row depends on the payload's own hash. The plan is therefore shaped as the row it is about to
 * become — identical in every field the payload reads (allocation, sequence, local uuid, quantity)
 * — and the journal columns are filled in when the rows are actually written a few lines later.
 */
function plannedConsumptionRow(
  planned: {
    readonly itemLocalUuid: string
    readonly entry: {
      readonly allocationUuid: string
      readonly rightsGeneration: number
      readonly consumptionSequence: number
      readonly localConsumptionUuid: string
      readonly quantityMilli: number
    }
  },
  invoiceLocalUuid: string,
  committedAt: string
): LocalStockAllocationConsumptionRow {
  return {
    localUuid: planned.entry.localConsumptionUuid,
    allocationUuid: planned.entry.allocationUuid,
    consumptionSequence: planned.entry.consumptionSequence,
    invoiceLocalUuid,
    itemLocalUuid: planned.itemLocalUuid,
    quantityMilli: planned.entry.quantityMilli,
    serverStatus: 'pending',
    serverConsumptionUuid: null,
    acknowledgedAt: null,
    createdAt: committedAt,
    rightsGeneration: planned.entry.rightsGeneration,
    invoiceIdempotencyKey: invoiceLocalUuid,
    itemLineUuid: null,
    requestHash: null,
    entryHash: null,
    chainHash: null
  }
}

function isStorageFailure(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code

  return (
    typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
  )
}
