import { describe, expect, it } from 'vitest'
import type { PrepareOperationRow, PrepareOutcome } from '../repositories/preparation.repository'
import type { StockAllocationGrantRow } from '@shared/contracts/sale.contract'
import {
  PreparationReadinessService,
  type PreparationLiveAuthority
} from './preparationReadiness.service'

/*
 * CP4 — the §8.5 live countdown, as the plan's own acceptance table.
 *
 * §8.5 lists seven required scenarios by name. Each one is a case below, because the failure mode
 * they guard against is not a crash: it is a screen that confidently says "72 hours" when it should
 * say "70", which no other test would notice.
 */

const OWNER = { companyUuid: 'company', deviceUuid: 'device', warehouseUuid: 'warehouse' }
const PREPARED_AT = '2026-09-09T10:00:00Z'
const READY_UNTIL = '2026-09-12T10:00:00Z'
const COLA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SEVENTY_TWO_HOURS = 259_200

function operation(overrides: Partial<PrepareOperationRow> = {}): PrepareOperationRow {
  return {
    operationUuid: 'operation',
    cycleUuid: 'cycle',
    companyUuid: OWNER.companyUuid,
    deviceUuid: OWNER.deviceUuid,
    warehouseUuid: OWNER.warehouseUuid,
    requestedPolicyRevision: 1,
    canonicalRequestJson: '{}',
    requestHash: 'a'.repeat(64),
    selectedProductUuids: [COLA],
    capturedSessionEpoch: 1,
    state: 'applied',
    dispatchStartedAt: PREPARED_AT,
    preparedAt: PREPARED_AT,
    requiredDurationSeconds: SEVENTY_TWO_HOURS,
    requiredReadyUntil: READY_UNTIL,
    authorityReadyUntil: READY_UNTIL,
    result: 'ready_72h',
    primaryLimitingReason: 'required_window',
    appliedPolicyRevision: 1,
    manifestJson: '{}',
    authorityReferencesJson: '{}',
    conflictReason: null,
    capturedAt: PREPARED_AT,
    appliedAt: PREPARED_AT,
    ...overrides
  }
}

function grant(overrides: Partial<StockAllocationGrantRow> = {}): StockAllocationGrantRow {
  return {
    allocationUuid: 'allocation-1',
    contractVersion: 1,
    companyUuid: OWNER.companyUuid,
    deviceUuid: OWNER.deviceUuid,
    warehouseUuid: OWNER.warehouseUuid,
    productUuid: COLA,
    serverSequence: 1,
    rightsGeneration: 1,
    lifecycleGeneration: 1,
    grantedQuantityMilli: 30_000,
    serverConsumedQuantityMilli: 0,
    serverRemainingQuantityMilli: 30_000,
    consumeUntil: READY_UNTIL,
    status: 'active',
    envelopeHash: 'b'.repeat(64),
    sealNonce: null,
    finalConsumptionSequence: null,
    finalConsumptionHash: null,
    receivedAt: PREPARED_AT,
    sealedAt: null,
    acknowledgedAt: null,
    releasedAt: null,
    lastObservedRevision: 1,
    updatedAt: PREPARED_AT,
    ...overrides
  } as StockAllocationGrantRow
}

function outcome(overrides: Partial<PrepareOutcome> = {}): PrepareOutcome {
  return {
    productUuid: COLA,
    reason: 'full',
    grantedQuantityMilli: 30_000,
    allocationUuid: 'allocation-1',
    issuedAt: PREPARED_AT,
    consumeUntil: READY_UNTIL,
    windowQualifiedHoldMilli: 0,
    shortLivedHoldMilli: 0,
    expiredHoldMilli: 0,
    quarantinedHoldMilli: 0,
    blockingAllocationUuids: [],
    ...overrides
  }
}

function build(params: {
  readonly nowIso: string
  readonly operation?: PrepareOperationRow | null
  readonly grants?: readonly StockAllocationGrantRow[]
  readonly spendable?: number
  readonly outcomes?: readonly PrepareOutcome[]
  readonly rollbackDetected?: boolean
  readonly trustedAvailable?: boolean
}): PreparationReadinessService {
  return new PreparationReadinessService({
    preparation: {
      latestAppliedOperation: () =>
        params.operation === undefined ? operation() : params.operation,
      unresolvedOperations: () => [],
      outcomes: () => params.outcomes ?? [outcome()],
      findCycle: () => null,
      cycleProducts: () => []
    },
    stockAllocations: {
      usableGrantsForProduct: () => params.grants ?? [grant()],
      spendableMilli: () => params.spendable ?? 30_000
    },
    trustedClock: {
      now: () =>
        params.trustedAvailable === false
          ? null
          : { now: new Date(params.nowIso), rollbackDetected: params.rollbackDetected ?? false }
    }
  })
}

const authority: PreparationLiveAuthority = {
  observedBoundaries: [],
  blockingRestriction: null,
  sessionEpoch: 1,
  lastTrustedObservationAt: PREPARED_AT
}

describe('the §8.5 live countdown', () => {
  it('shows ~70 hours two hours after preparation, never 72', () => {
    // §8.5's worked example verbatim. "Showing 72 hours again, or re-deriving the countdown from
    // the moment the screen opened, is forbidden."
    const readiness = build({ nowIso: '2026-09-09T12:00:00Z' }).project(OWNER, authority)

    expect(readiness.time.remainingSeconds).toBe(70 * 3600)
    expect(readiness.time.state).toBe('counting_down')
    // The original window is still reported — as history, next to the live number.
    expect(readiness.time.requestedDurationSeconds).toBe(SEVENTY_TWO_HOURS)
    expect(readiness.time.originalResult).toBe('ready_72h')
    expect(readiness.time.preparedAt).toBe(PREPARED_AT)
  })

  it('claims the full window only at the instant of preparation', () => {
    // §8.6: the exact full-window phrase appears only while the whole requested window remains.
    expect(build({ nowIso: PREPARED_AT }).project(OWNER, authority).time.state).toBe(
      'ready_full_window'
    )
    // One second later it is a countdown, which is a different state and a different message.
    expect(build({ nowIso: '2026-09-09T10:00:01Z' }).project(OWNER, authority).time.state).toBe(
      'counting_down'
    )
  })

  it('measures a delayed response from prepared_at, not from receipt', () => {
    // §8.5: "a decision prepared at 10:00 whose response arrives at 10:20 still expires at
    // 10:00 + 72h, because the countdown uses the server's immutable prepared_at and never the
    // local receipt, ingestion, or commit time."
    const readiness = build({
      nowIso: '2026-09-09T10:20:00Z',
      operation: operation({ appliedAt: '2026-09-09T10:20:00Z' })
    }).project(OWNER, authority)

    expect(readiness.time.effectiveReadyUntil).toBe(READY_UNTIL)
    expect(readiness.time.remainingSeconds).toBe(SEVENTY_TWO_HOURS - 20 * 60)
  })

  it('yields zero remaining and expired at exact expiry', () => {
    const readiness = build({ nowIso: READY_UNTIL }).project(OWNER, authority)

    expect(readiness.time.remainingSeconds).toBe(0)
    expect(readiness.time.state).toBe('expired')
  })

  it('shortens for a boundary observed after preparation, and never lengthens', () => {
    const shortened = build({ nowIso: '2026-09-09T12:00:00Z' }).project(OWNER, {
      ...authority,
      observedBoundaries: [{ reason: 'subscription_expires', deadline: '2026-09-10T10:00:00Z' }]
    })

    expect(shortened.time.effectiveReadyUntil).toBe('2026-09-10T10:00:00Z')
    expect(shortened.time.limitingReason).toBe('subscription_expires')
    expect(shortened.time.newlyObservedRestriction).toBe('subscription_expires')

    // A *later* boundary is ignored outright. Nothing moves the window later — §13 lists a window
    // that lengthens as a stop condition.
    const lengthened = build({ nowIso: '2026-09-09T12:00:00Z' }).project(OWNER, {
      ...authority,
      observedBoundaries: [{ reason: 'subscription_expires', deadline: '2099-01-01T00:00:00Z' }]
    })

    expect(lengthened.time.effectiveReadyUntil).toBe(READY_UNTIL)
    expect(lengthened.time.newlyObservedRestriction).toBeNull()
  })

  it('blocks on a changed session or an observed revocation regardless of remaining time', () => {
    // §8.5: "an operator whose session changed or whose access was revoked is not ready merely
    // because a past decision said so."
    const revoked = build({ nowIso: '2026-09-09T12:00:00Z' }).project(OWNER, {
      ...authority,
      blockingRestriction: 'device-revoked'
    })

    expect(revoked.time.state).toBe('blocked')
    expect(revoked.time.remainingSeconds).toBeGreaterThan(0)
    expect(revoked.time.newlyObservedRestriction).toBe('device-revoked')

    const rotatedSession = build({ nowIso: '2026-09-09T12:00:00Z' }).project(OWNER, {
      ...authority,
      sessionEpoch: 2
    })

    expect(rotatedSession.time.state).toBe('blocked')
  })

  it('blocks when trusted time is unavailable rather than estimating from the wall clock', () => {
    const readiness = build({
      nowIso: '2026-09-09T12:00:00Z',
      trustedAvailable: false
    }).project(OWNER, authority)

    expect(readiness.time.state).toBe('blocked')
    expect(readiness.time.newlyObservedRestriction).toBe('trusted_time_unavailable')
    expect(readiness.time.remainingSeconds).toBe(0)
  })

  it('blocks on a detected clock rollback', () => {
    const readiness = build({
      nowIso: '2026-09-09T12:00:00Z',
      rollbackDetected: true
    }).project(OWNER, authority)

    expect(readiness.time.state).toBe('blocked')
    expect(readiness.time.newlyObservedRestriction).toBe('trusted_time_rollback')
  })

  it('reports every tied limiter, never just the first', () => {
    // §8.6 forbids hiding a second limiter that expires at the same instant.
    const readiness = build({ nowIso: '2026-09-09T12:00:00Z' }).project(OWNER, {
      ...authority,
      observedBoundaries: [{ reason: 'catalog_expires', deadline: READY_UNTIL }]
    })

    expect(readiness.time.tiedLimitingReasons).toContain('required_window')
    expect(readiness.time.tiedLimitingReasons).toContain('catalog_expires')
  })

  it('reports nothing prepared when no operation has ever been applied', () => {
    const readiness = build({ nowIso: '2026-09-09T12:00:00Z', operation: null }).project(
      OWNER,
      authority
    )

    expect(readiness.available).toBe(false)
    expect(readiness.time.state).toBe('not_prepared')
  })
})

describe('the §8.6 quantity panel', () => {
  it('keeps time and quantity independent: quantity may be zero while time is not', () => {
    // §8.5's "partial consumption" row: time remaining unchanged, per-product usable quantity
    // reduced, and the quantity panel may read zero while time is non-zero.
    const readiness = build({
      nowIso: '2026-09-09T12:00:00Z',
      spendable: 0,
      grants: [grant()]
    }).project(OWNER, authority)

    expect(readiness.time.remainingSeconds).toBe(70 * 3600)
    expect(readiness.quantity.state).toBe('zero')
    expect(readiness.quantity.products[0]?.usableNowMilli).toBe(0)
  })

  it('excludes a short-lived grant from window coverage while keeping it usable now', () => {
    // §8.1: existing grants ending before the window contribute zero to Q72, but remain spendable
    // before their own expiry. Those are different questions and get different numbers.
    const readiness = build({
      nowIso: '2026-09-09T12:00:00Z',
      grants: [grant({ consumeUntil: '2026-09-10T10:00:00Z' })],
      spendable: 30_000
    }).project(OWNER, authority)

    const product = readiness.quantity.products[0]

    expect(product?.usableNowMilli).toBe(30_000)
    expect(product?.coveredForWindowMilli).toBe(0)
    expect(product?.shortLivedMilli).toBe(30_000)
  })

  it('counts a grant ending exactly at the deadline as covered', () => {
    // §8.1: "Grants ending exactly at D qualify because no sale may commit at D."
    const readiness = build({
      nowIso: '2026-09-09T12:00:00Z',
      grants: [grant({ consumeUntil: READY_UNTIL })]
    }).project(OWNER, authority)

    expect(readiness.quantity.products[0]?.coveredForWindowMilli).toBe(30_000)
    expect(readiness.quantity.products[0]?.shortLivedMilli).toBe(0)
  })

  it('reports held-but-unspendable quantity separately from usable quantity', () => {
    const readiness = build({
      nowIso: '2026-09-09T12:00:00Z',
      outcomes: [outcome({ expiredHoldMilli: 40_000, quarantinedHoldMilli: 5_000 })]
    }).project(OWNER, authority)

    // §4.4: an expired hold is real, conserved, and occupies capacity. It is never silently
    // dropped from the display just because it cannot be sold.
    expect(readiness.quantity.products[0]?.heldNotSpendableMilli).toBe(45_000)
  })
})
