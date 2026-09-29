import { describe, expect, it } from 'vitest'
import { syncSupportIssuesSchema } from '@shared/contracts/sync.contract'
import type {
  AllocationDispatchRow,
  AllocationDispatchState
} from '../repositories/allocationDispatch.repository'
import type { LegacyDispatchUncertaintyRow } from '../repositories/saleAttempt.repository'
import type { SaleAttemptRow } from '@shared/contracts/sale.contract'
import { SupportIssuesService, supportReference } from './supportIssues.service'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const DEVICE = '33333333-3333-4333-8333-333333333333'
const ME = '44444444-4444-4444-8444-444444444444'
const OTHER = '55555555-5555-4555-8555-555555555555'
const PRODUCT = '66666666-6666-4666-8666-666666666666'

function dispatch(
  key: string,
  state: AllocationDispatchState,
  overrides: Partial<AllocationDispatchRow> = {}
): AllocationDispatchRow {
  return {
    idempotencyKey: key.padEnd(64, '0'),
    attemptKey: 'attempt-1',
    companyUuid: COMPANY,
    deviceUuid: DEVICE,
    warehouseUuid: 'w',
    actorUserUuid: ME,
    requestHash: 'h'.repeat(64),
    requestBody: {
      idempotency_key: key.padEnd(64, '0'),
      allocation_payload_version: 2,
      items: [{ product_uuid: PRODUCT, quantity: '2.000' }]
    },
    state,
    sendCount: 3,
    ambiguousSendCount: state === 'dispatched' ? 3 : 0,
    lastOutcome: state === 'conflict' ? { kind: 'response', traceId: 'trace-abc' } : null,
    retryNotBefore: state === 'dispatched' ? '2026-09-29T12:10:00.000Z' : null,
    createdAt: '2026-09-29T12:00:00.000Z',
    resolvedAt: state === 'dispatched' ? null : '2026-09-29T12:01:00.000Z',
    ...overrides
  }
}

function legacy(userUuid: string): LegacyDispatchUncertaintyRow {
  return {
    attemptKey: 'abcdef01-2345-4678-9abc-def012345678',
    userUuid,
    productQuantities: [{ productUuid: PRODUCT, quantity: '1' }],
    claimedAt: '2026-09-28T09:00:00.000Z',
    recordedAt: '2026-09-29T11:00:00.000Z',
    status: 'open'
  }
}

function build(options: {
  rows?: AllocationDispatchRow[]
  legacyRows?: LegacyDispatchUncertaintyRow[]
  blocking?: SaleAttemptRow | null
  needsSupport?: boolean
  session?: { isAuthenticated: boolean; companyUuid: string | null; userUuid: string | null }
}): {
  service: SupportIssuesService
  calls: Array<{ owner: unknown; states: readonly string[] }>
} {
  const calls: Array<{ owner: unknown; states: readonly string[] }> = []
  const rows = options.rows ?? []
  const service = new SupportIssuesService({
    session: {
      getContext: () => ({
        isAuthenticated: options.session?.isAuthenticated ?? true,
        companyUuid: options.session ? options.session.companyUuid : COMPANY,
        deviceUuid: DEVICE,
        userUuid: options.session ? options.session.userUuid : ME
      })
    },
    allocationDispatches: {
      listForOwnerByStates: (owner, states) => {
        calls.push({ owner, states })
        // The repository scopes by company + device; mirror it so a leak would show up here.
        return rows.filter(
          (row) =>
            row.companyUuid === owner.companyUuid &&
            row.deviceUuid === owner.deviceUuid &&
            states.includes(row.state)
        )
      }
    },
    saleAttempts: {
      listOpenLegacyUncertainties: () => options.legacyRows ?? [],
      findBlockingForOwner: () => options.blocking ?? null
    },
    recoverySummary: () => ({
      legacyDispatchUnknown: false,
      outstandingRequests: 1,
      needsSupport: options.needsSupport ?? false,
      supportReference: options.needsSupport ? 'trace-abc' : null
    }),
    productName: (uuid) => (uuid === PRODUCT ? 'Cola Can' : null)
  })
  return { service, calls }
}

describe('SupportIssuesService', () => {
  it('returns nothing without an authenticated session, and never reads unscoped', () => {
    const { service, calls } = build({
      rows: [dispatch('a', 'conflict')],
      session: { isAuthenticated: false, companyUuid: null, userUuid: null }
    })
    expect(service.list()).toEqual({
      needsSupport: [],
      automaticReconciliation: [],
      paymentAwaitingDecision: null
    })
    expect(calls).toEqual([])
  })

  it('groups integrity issues and legacy uncertainties as needing support, pending rows apart', () => {
    const { service } = build({
      rows: [
        dispatch('a', 'conflict'),
        dispatch('b', 'invalid'),
        dispatch('c', 'dispatched'),
        dispatch('d', 'granted'),
        dispatch('e', 'refused')
      ],
      legacyRows: [legacy(ME)]
    })
    const result = syncSupportIssuesSchema.parse(service.list())

    expect(result.needsSupport.map((issue) => issue.kind).sort()).toEqual([
      'allocation-identity-conflict',
      'allocation-request-invalid',
      'legacy-dispatch-uncertainty'
    ])
    expect(result.automaticReconciliation).toHaveLength(1)
    expect(result.automaticReconciliation[0]).toMatchObject({
      kind: 'allocation-request-pending',
      sendCount: 3,
      nextAttemptAfter: '2026-09-29T12:10:00.000Z',
      updatedAt: null
    })
    const conflict = result.needsSupport.find(
      (issue) => issue.kind === 'allocation-identity-conflict'
    )
    expect(conflict).toMatchObject({
      reference: supportReference('AD', 'a'.padEnd(64, '0')),
      traceId: 'trace-abc',
      ownedByCurrentUser: true,
      lines: [{ productName: 'Cola Can', quantity: '2.000' }],
      sendCount: null
    })
  })

  it("withholds every transaction detail of another cashier's records on this workstation", () => {
    const { service } = build({
      rows: [dispatch('a', 'conflict', { actorUserUuid: OTHER })],
      legacyRows: [legacy(OTHER)]
    })
    const result = syncSupportIssuesSchema.parse(service.list())

    expect(result.needsSupport).toHaveLength(2)
    for (const issue of result.needsSupport) {
      expect(issue.ownedByCurrentUser).toBe(false)
      expect(issue.lines).toBeNull()
      expect(issue.reference).toMatch(/^(AD|SA)-[0-9A-F]{12}$/)
    }
    expect(JSON.stringify(result)).not.toContain(PRODUCT)
    expect(JSON.stringify(result)).not.toContain('Cola Can')
  })

  it('excludes records of another company or device', () => {
    const { service } = build({
      rows: [
        dispatch('a', 'conflict', { companyUuid: '99999999-9999-4999-8999-999999999999' }),
        dispatch('b', 'dispatched', { deviceUuid: '88888888-8888-4888-8888-888888888888' })
      ]
    })
    const result = service.list()
    expect(result.needsSupport).toEqual([])
    expect(result.automaticReconciliation).toEqual([])
  })

  it('reports the waiting payment, and that Retry is unavailable for an integrity conflict', () => {
    const blocking = {
      attemptKey: '0f1e2d3c-4b5a-4968-8776-655443322110',
      claimedAt: '2026-09-29T12:00:00.000Z',
      failureCode: 'allocation-integrity-blocked'
    } as SaleAttemptRow
    const { service } = build({ blocking, needsSupport: true })
    const payment = syncSupportIssuesSchema.parse(service.list()).paymentAwaitingDecision

    expect(payment).toEqual({
      reference: 'SA-0F1E2D3C4B5A',
      claimedAt: '2026-09-29T12:00:00.000Z',
      failureCode: 'allocation-integrity-blocked',
      retryAvailable: false,
      legacyDispatchUnknown: false,
      outstandingRequests: 1,
      traceId: 'trace-abc'
    })
  })

  it('exposes no mutating operation', () => {
    const { service } = build({})
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(service)).filter(
      (name) => name !== 'constructor' && !name.startsWith('from') && name !== 'lines'
    )
    expect(methods.sort()).toEqual(['blockingPayment', 'list'])
  })
})
