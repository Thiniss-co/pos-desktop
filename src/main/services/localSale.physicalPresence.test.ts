import { describe, expect, it } from 'vitest'
import { splitAllocations } from './stockAllocation.service'
import { buildUploadPayload } from './localSale.payload'
import { extractQuarantineReason, mapUploadFailure } from '../sync/invoiceUploadMapping'
import type {
  LocalInvoiceItemRow,
  LocalInvoicePaymentRow,
  LocalInvoiceRow,
  StockAllocationGrantRow
} from '@shared/contracts/sale.contract'
import type { PublicAppError } from '@shared/contracts/api.contract'

const HASH_64 = 'a'.repeat(64)

function grant(overrides: Partial<StockAllocationGrantRow> = {}): StockAllocationGrantRow {
  return {
    allocationUuid: 'grant-a',
    companyUuid: 'company-uuid',
    deviceUuid: 'device-uuid',
    warehouseUuid: 'warehouse-uuid',
    productUuid: 'product-uuid',
    serverSequence: 1,
    rightsGeneration: 1,
    lifecycleGeneration: 1,
    grantedQuantityMilli: 10_000,
    serverConsumedQuantityMilli: 0,
    serverRemainingQuantityMilli: 10_000,
    consumeUntil: '2099-01-01T00:00:00.000Z',
    status: 'active',
    envelopeHash: HASH_64,
    issuedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  } as StockAllocationGrantRow
}

function invoice(overrides: Partial<LocalInvoiceRow> = {}): LocalInvoiceRow {
  return {
    localUuid: 'invoice-uuid',
    attemptKey: 'attempt-uuid',
    offlineNumber: 'POS-333333-20260101-000001',
    remoteUuid: null,
    serverNumber: null,
    syncStatus: 'pending',
    syncAttempts: 0,
    lastSyncError: null,
    syncedAt: null,
    companyUuid: 'company-uuid',
    branchUuid: 'branch-uuid',
    warehouseUuid: 'warehouse-uuid',
    deviceUuid: 'device-uuid',
    userUuid: 'user-uuid',
    shiftUuid: 'shift-uuid',
    commitSessionEpoch: 1,
    catalogRevision: HASH_64,
    intentFingerprint: 'b'.repeat(64),
    customerUuid: null,
    currency: 'EGP',
    currencyExponent: 2,
    taxMode: 'none',
    invoiceDiscountType: null,
    invoiceDiscountValue: 0,
    subtotalAmount: 1500,
    discountTotalAmount: 0,
    taxTotalAmount: 0,
    grandTotalAmount: 1500,
    paidTotalAmount: 1500,
    changeDueAmount: 0,
    dueAmount: 0,
    soldAt: '2026-01-01T02:00:00.000Z',
    connectivityStateAtSale: 'offline',
    soldWhileOffline: true,
    notes: null,
    commercialSnapshotJson: '{}',
    uploadPayloadVersion: 2,
    offlineSaleAuthorityUuid: null,
    stockAuthorizationPolicy: null,
    createdAt: '2026-01-01T02:00:00.000Z',
    updatedAt: '2026-01-01T02:00:00.000Z',
    ...overrides
  }
}

function item(overrides: Partial<LocalInvoiceItemRow> = {}): LocalInvoiceItemRow {
  return {
    localUuid: 'item-1-uuid',
    invoiceLocalUuid: 'invoice-uuid',
    lineIndex: 0,
    productUuid: 'product-uuid',
    productName: 'Water 500ml',
    sku: null,
    barcode: null,
    unit: null,
    trackStock: true,
    quantityMilli: 22_000,
    unitPriceAmount: 1000,
    currency: 'EGP',
    priceRevision: HASH_64,
    taxUuid: null,
    taxMode: 'none',
    taxRateBasisPoints: 0,
    taxRevision: HASH_64,
    discountType: null,
    discountValue: 0,
    subtotalAmount: 22_000,
    discountAmount: 0,
    taxAmount: 0,
    totalAmount: 22_000,
    allocationCoveredMilli: 0,
    uncoveredMilli: 22_000,
    createdAt: '2026-01-01T02:00:00.000Z',
    ...overrides
  }
}

const payment: LocalInvoicePaymentRow = {
  localUuid: 'payment-uuid',
  invoiceLocalUuid: 'invoice-uuid',
  paymentIndex: 0,
  paymentMethodUuid: 'method-uuid',
  type: 'cash',
  amount: 22_000,
  reference: null,
  requiresReference: false,
  paidAt: '2026-01-01T02:00:00.000Z',
  methodSnapshotJson: '{}',
  createdAt: '2026-01-01T02:00:00.000Z'
}

describe('PS4 drain-first partial allocation split', () => {
  it('refuses an uncovered remainder by default, exactly as today', () => {
    // The legacy D2-B rule is the DEFAULT and is unchanged. A caller that does not explicitly ask
    // for the partial mode cannot accidentally receive an under-covered split.
    const grantA = grant()
    const result = splitAllocations({
      grants: [grantA],
      remainingMilliByAllocation: new Map([[grantA.allocationUuid, 5_000]]),
      nextSequenceByAllocation: new Map([[grantA.allocationUuid, 1]]),
      lineDemandsMilli: [12_000],
      createUuid: () => 'consumption-uuid'
    })

    expect(result).toEqual({ ok: false, code: 'stock-allocation-unavailable' })
  })

  it('drains the grant first and reports only the true remainder', () => {
    // §7.1: grants are drained FIRST. That ordering is what keeps allocation exposure falling —
    // leaving a usable grant held while selling the same units under physical presence would grow
    // the stranded quantity instead.
    const grantA = grant()
    const result = splitAllocations({
      grants: [grantA],
      remainingMilliByAllocation: new Map([[grantA.allocationUuid, 5_000]]),
      nextSequenceByAllocation: new Map([[grantA.allocationUuid, 1]]),
      lineDemandsMilli: [12_000],
      createUuid: () => 'consumption-uuid',
      allowUncoveredRemainder: true
    })

    expect(result.ok).toBe(true)

    if (!result.ok) {
      return
    }

    expect(result.perLine[0]).toHaveLength(1)
    expect(result.perLine[0][0].quantityMilli).toBe(5_000)
    expect(result.uncoveredMilliByLine).toEqual([7_000])
  })

  it('reports a fully uncovered line when the device holds no grant at all', () => {
    // Acceptance row 2: the zero-allocation sale, which is the whole point of the mode.
    const result = splitAllocations({
      grants: [],
      remainingMilliByAllocation: new Map(),
      nextSequenceByAllocation: new Map(),
      lineDemandsMilli: [22_000],
      createUuid: () => 'consumption-uuid',
      allowUncoveredRemainder: true
    })

    expect(result).toEqual({ ok: true, perLine: [[]], uncoveredMilliByLine: [22_000] })
  })
})

describe('PS4 v3 payload emission', () => {
  it('emits v2 bytes unchanged when no authority governs the sale', () => {
    // The compatibility property: a device that has never negotiated an authority produces exactly
    // the payload it produces today, with no new keys at all.
    const payload = buildUploadPayload(
      invoice(),
      [item({ allocationCoveredMilli: 22_000, uncoveredMilli: 0 })],
      [payment],
      new Map(),
      new Map()
    )

    expect(payload.client_contract_version).toBe(2)
    expect(payload).not.toHaveProperty('offline_sale_authority_uuid')
    expect((payload.items as Record<string, unknown>[])[0]).not.toHaveProperty(
      'stock_authorization'
    )
  })

  it('emits v3 with the authority reference and per-line intent under an authority', () => {
    const payload = buildUploadPayload(
      invoice({
        offlineSaleAuthorityUuid: 'authority-uuid',
        stockAuthorizationPolicy: 'physical_presence'
      }),
      [item()],
      [payment],
      new Map(),
      new Map()
    )

    expect(payload.client_contract_version).toBe(3)
    expect(payload.offline_sale_authority_uuid).toBe('authority-uuid')
    expect((payload.items as Record<string, unknown>[])[0].stock_authorization).toBe(
      'physical_presence'
    )
  })

  it('derives the per-line intent from the committed split, never from a guess', () => {
    // §6.7: the server cross-checks this against the proofs actually attached, so a value derived
    // from anything other than the committed split would be rejected — correctly.
    const cases: Array<[number, number, string]> = [
      [22_000, 0, 'allocation'],
      [5_000, 17_000, 'mixed'],
      [0, 22_000, 'physical_presence']
    ]

    for (const [covered, uncovered, expected] of cases) {
      const payload = buildUploadPayload(
        invoice({ offlineSaleAuthorityUuid: 'authority-uuid' }),
        [item({ allocationCoveredMilli: covered, uncoveredMilli: uncovered })],
        [payment],
        new Map(),
        new Map()
      )

      expect((payload.items as Record<string, unknown>[])[0].stock_authorization).toBe(expected)
    }
  })

  it('never emits a per-line intent on an untracked line', () => {
    const payload = buildUploadPayload(
      invoice({ offlineSaleAuthorityUuid: 'authority-uuid' }),
      [item({ trackStock: false, allocationCoveredMilli: 0, uncoveredMilli: 0 })],
      [payment],
      new Map(),
      new Map()
    )

    const line = (payload.items as Record<string, unknown>[])[0]
    expect(line).not.toHaveProperty('stock_authorization')
    expect(line).not.toHaveProperty('allocations')
  })
})

describe('PS4 quarantine classification', () => {
  function error(overrides: Partial<PublicAppError> = {}): PublicAppError {
    return {
      category: 'validation',
      message: 'quarantined',
      backendCode: 'DESKTOP_INVOICE_QUARANTINED',
      httpStatus: 422,
      ...overrides
    } as PublicAppError
  }

  it('classifies a quarantine terminally and preserves its exact reason', () => {
    // Review finding T3: before PS4 this code was unlisted, so `backendCode` was STRIPPED during
    // normalization and the failure fell through as retryable — a permanently invalid claim that the
    // worker would re-send forever, with its reason lost.
    const disposition = mapUploadFailure(
      error({ fieldErrors: { quarantine_reason: ['allocation_sequence_gap'] } }),
      1,
      () => 0
    )

    expect(disposition.kind).toBe('outcome')
    expect(disposition.outcome.kind).toBe('rejected')

    if (disposition.outcome.kind !== 'rejected') {
      throw new Error('expected a terminal rejection')
    }

    expect(disposition.outcome.details?.backendCode).toBe('DESKTOP_INVOICE_QUARANTINED')
    expect(disposition.outcome.details?.quarantineReason).toBe('allocation_sequence_gap')
  })

  it('fails closed on a malformed, multiple or unknown reason rather than guessing', () => {
    // §7.3a.4: message text is NEVER interpreted, and an unknown reason is recorded as a contract
    // error rather than accepted. PS6b will not treat such a row as a disposition candidate.
    const shapes: Array<Record<string, string[]> | undefined> = [
      undefined,
      {},
      { quarantine_reason: [] },
      { quarantine_reason: ['allocation_sequence_gap', 'allocation_not_owned'] },
      { quarantine_reason: ['catalog_window_violation'] },
      { quarantine_reason: ['something_new'] }
    ]

    for (const fieldErrors of shapes) {
      const disposition = mapUploadFailure(error({ fieldErrors }), 1, () => 0)

      if (disposition.outcome.kind !== 'rejected') {
        throw new Error('expected a terminal rejection')
      }

      expect(disposition.outcome.details?.quarantineReason).toBeUndefined()
      expect(disposition.outcome.details?.quarantineReasonContractError).toBe(true)
    }
  })

  it('accepts exactly the five allocation reasons and nothing else', () => {
    for (const reason of [
      'allocation_not_owned',
      'allocation_generation_mismatch',
      'allocation_sequence_gap',
      'allocation_insufficient_rights',
      'allocation_expired_at_sale_time'
    ]) {
      expect(extractQuarantineReason({ quarantine_reason: [reason] })).toEqual({ ok: true, reason })
    }

    expect(extractQuarantineReason({ quarantine_reason: ['catalog_window_violation'] })).toEqual({
      ok: false,
      code: 'contract-error'
    })
  })

  it('keeps an unsupported contract version RETRYABLE, never terminal', () => {
    // §15.1, and the polarity that matters most: this means the server is currently below the v3
    // parsing floor. Rejecting it terminally would let a routine backend rollback permanently
    // destroy legitimate committed sales.
    const disposition = mapUploadFailure(
      error({ backendCode: 'DESKTOP_CONTRACT_VERSION_UNSUPPORTED' }),
      1,
      () => 0
    )

    expect(disposition.outcome.kind).toBe('retryable')
  })

  it('classifies an invalid authority terminally', () => {
    // Permanently invalid, and explicitly never disposition-eligible — accepting it would
    // manufacture authority.
    const disposition = mapUploadFailure(
      error({ backendCode: 'DESKTOP_OFFLINE_SALE_AUTHORITY_INVALID' }),
      1,
      () => 0
    )

    expect(disposition.outcome.kind).toBe('rejected')
  })
})
