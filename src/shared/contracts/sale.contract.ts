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
  readonly createdAt: string
  readonly updatedAt: string
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
