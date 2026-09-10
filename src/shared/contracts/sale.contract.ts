// Phase 3F plan §2.1/§5.3-§5.4. Row shapes returned by the CP-1 local-sale repositories. These are
// internal main-process types, never parsed from untrusted external input at this layer — the
// renderer-facing intent/outcome/recovery unions belong to checkout.contract.ts (CP-2).

export type SaleAttemptState = 'claimed' | 'committed' | 'rejected' | 'acknowledged' | 'abandoned'

export type LocalInvoiceSyncStatus =
  'pending' | 'uploading' | 'synced' | 'retryable_error' | 'conflict' | 'rejected'

export type LocalStockMovementSyncStatus =
  'pending' | 'uploading' | 'retryable_error' | 'conflict' | 'rejected'

export type ConnectivityStateAtSale = 'online' | 'offline' | 'unknown'
export type InvoiceTaxMode = 'none' | 'inclusive' | 'exclusive'
export type InvoiceDiscountType = 'fixed' | 'percentage'
export type InvoicePaymentType = 'cash' | 'card' | 'other'
/**
 * Server lifecycle values are preserved exactly. `legacy-*` values exist only for grants written
 * by the pre-bootstrap schema and are never sellable; they retain evidence until normal recovery
 * can reconcile it instead of silently discarding an unresolved reservation.
 */
export type StockAllocationGrantStatus =
  | 'active'
  | 'revocation_pending'
  | 'seal_acknowledged'
  | 'released'
  | 'consumed'
  | 'legacy-sealed'
  | 'legacy-expired'
export type AllocationConsumptionServerStatus = 'pending' | 'acknowledged'

export interface SaleAttemptRow {
  readonly attemptKey: string
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly userUuid: string
  readonly claimSessionEpoch: number
  readonly originShiftUuid: string
  readonly originShiftObservedAt: string
  readonly originBranchUuid: string
  readonly originWarehouseUuid: string
  readonly originContextFingerprint: string
  readonly intentFingerprint: string
  readonly intentVersion: number
  readonly intentJson: string | null
  readonly state: SaleAttemptState
  readonly invoiceLocalUuid: string | null
  readonly failureCode: string | null
  readonly claimedAt: string
  readonly lastAttemptedAt: string | null
  readonly committedAt: string | null
  readonly rejectedAt: string | null
  readonly acknowledgedAt: string | null
  readonly abandonedAt: string | null
  readonly updatedAt: string
}

export interface NewSaleAttempt {
  readonly attemptKey: string
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly userUuid: string
  readonly claimSessionEpoch: number
  readonly originShiftUuid: string
  readonly originShiftObservedAt: string
  readonly originBranchUuid: string
  readonly originWarehouseUuid: string
  readonly originContextFingerprint: string
  readonly intentFingerprint: string
  readonly intentVersion: number
  readonly intentJson: string
  readonly claimedAt: string
}

export interface LocalInvoiceRow {
  readonly localUuid: string
  readonly attemptKey: string
  readonly offlineNumber: string
  readonly remoteUuid: string | null
  readonly serverNumber: string | null
  readonly syncStatus: LocalInvoiceSyncStatus
  readonly syncAttempts: number
  readonly lastSyncError: string | null
  readonly syncedAt: string | null
  readonly companyUuid: string
  readonly branchUuid: string
  readonly warehouseUuid: string
  readonly deviceUuid: string
  readonly userUuid: string
  readonly shiftUuid: string
  readonly commitSessionEpoch: number
  readonly catalogRevision: string
  readonly intentFingerprint: string
  readonly customerUuid: string | null
  readonly currency: string
  readonly currencyExponent: number
  readonly taxMode: InvoiceTaxMode
  readonly invoiceDiscountType: InvoiceDiscountType | null
  readonly invoiceDiscountValue: number
  readonly subtotalAmount: number
  readonly discountTotalAmount: number
  readonly taxTotalAmount: number
  readonly grandTotalAmount: number
  readonly paidTotalAmount: number
  readonly changeDueAmount: number
  readonly dueAmount: number
  readonly soldAt: string
  readonly connectivityStateAtSale: ConnectivityStateAtSale
  readonly soldWhileOffline: boolean
  readonly notes: string | null
  readonly commercialSnapshotJson: string
  readonly uploadPayloadVersion: number
  /**
   * PS4: the server-issued authority this sale was rung under, or null for a legacy
   * allocation-exclusive sale.
   *
   * Its presence is what selects the v3 payload shape, so it is a property of the committed sale
   * rather than of the process that later uploads it. That is deliberate: a queued payload can never
   * be upgraded in place, so the version must be decided once, at commit, and never revisited.
   */
  readonly offlineSaleAuthorityUuid: string | null
  readonly stockAuthorizationPolicy: StockAuthorizationPolicy | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** PS4 §5: which authority governs a tracked line in a given scope. */
export type StockAuthorizationPolicy = 'allocation_exclusive' | 'physical_presence'

/** PS4 §6.7: what actually authorized one tracked invoice line to leave the warehouse. */
export type StockAuthorization = 'allocation' | 'physical_presence' | 'mixed'

/**
 * PS4 §6.2: one server-issued offline-sale authority, stored verbatim.
 *
 * Never minted, extended or recomputed locally. `notAfter` is the server's own clipped value; the
 * desktop only compares against it.
 */
export interface OfflineSaleAuthorityRow {
  readonly authorityUuid: string
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly mode: StockAuthorizationPolicy
  readonly policyRevision: number
  readonly contractVersion: number
  readonly issuedAt: string
  readonly notBefore: string
  readonly notAfter: string
  readonly authorityHash: string
  readonly observedAt: string
  readonly createdAt: string
}

export interface LocalInvoiceItemRow {
  readonly localUuid: string
  readonly invoiceLocalUuid: string
  readonly lineIndex: number
  readonly productUuid: string
  readonly productName: string
  readonly sku: string | null
  readonly barcode: string | null
  readonly unit: string | null
  readonly trackStock: boolean
  readonly quantityMilli: number
  readonly unitPriceAmount: number
  readonly currency: string
  readonly priceRevision: string
  readonly taxUuid: string | null
  readonly taxMode: InvoiceTaxMode
  readonly taxRateBasisPoints: number
  readonly taxRevision: string
  readonly discountType: InvoiceDiscountType | null
  readonly discountValue: number
  readonly subtotalAmount: number
  readonly discountAmount: number
  readonly taxAmount: number
  readonly totalAmount: number
  /**
   * PS4 §8.4: the covered/uncovered split for this line, in integer thousandths.
   *
   * Recorded per line so the split is recoverable from committed rows alone, without re-deriving it
   * from the consumption journal. For a tracked line these sum to `quantityMilli`, enforced by a
   * conditional CHECK; for an untracked line both are zero.
   */
  readonly allocationCoveredMilli: number
  readonly uncoveredMilli: number
  readonly createdAt: string
}

export interface LocalInvoicePaymentRow {
  readonly localUuid: string
  readonly invoiceLocalUuid: string
  readonly paymentIndex: number
  readonly paymentMethodUuid: string
  readonly type: InvoicePaymentType
  readonly amount: number
  readonly reference: string | null
  readonly requiresReference: boolean
  readonly paidAt: string
  readonly methodSnapshotJson: string
  readonly createdAt: string
}

export interface StockAllocationGrantRow {
  readonly allocationUuid: string
  readonly contractVersion: number
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly warehouseUuid: string
  readonly productUuid: string
  readonly serverSequence: number
  readonly rightsGeneration: number
  readonly lifecycleGeneration: number
  readonly grantedQuantityMilli: number
  readonly serverConsumedQuantityMilli: number
  readonly serverRemainingQuantityMilli: number
  readonly consumeUntil: string
  readonly status: StockAllocationGrantStatus
  readonly envelopeHash: string
  readonly sealNonce: string | null
  readonly finalConsumptionSequence: number | null
  readonly finalConsumptionHash: string | null
  readonly receivedAt: string
  readonly sealedAt: string | null
  readonly acknowledgedAt: string | null
  readonly releasedAt: string | null
  /** The full bootstrap revision that last named this grant; omission never means release. */
  readonly lastObservedRevision: number | null
  readonly updatedAt: string
}

export interface LocalStockAllocationConsumptionRow {
  readonly localUuid: string
  readonly allocationUuid: string
  readonly consumptionSequence: number
  readonly invoiceLocalUuid: string
  readonly itemLocalUuid: string
  readonly quantityMilli: number
  readonly serverStatus: AllocationConsumptionServerStatus
  readonly serverConsumptionUuid: string | null
  readonly acknowledgedAt: string | null
  readonly createdAt: string
  /**
   * BH-04B-3 journal-v1 evidence (migration 0009). Pinned at commit rather than looked up later:
   * `rightsGeneration` used to be read from the grant at upload time, so a bootstrap arriving in
   * between could change what was sent. Null on a historical row whose evidence could not be
   * reconstructed — such a row is retained and its grant is held, never deleted or given invented
   * values.
   */
  readonly rightsGeneration: number | null
  readonly invoiceIdempotencyKey: string | null
  readonly itemLineUuid: string | null
  readonly requestHash: string | null
  readonly entryHash: string | null
  readonly chainHash: string | null
}

export interface LocalStockMovementRow {
  readonly localUuid: string
  readonly invoiceLocalUuid: string
  readonly itemLocalUuid: string
  readonly productUuid: string
  readonly warehouseUuid: string
  readonly direction: 'out'
  readonly quantityMilli: number
  readonly syncStatus: LocalStockMovementSyncStatus
  readonly syncedAt: null
  readonly createdAt: string
}
