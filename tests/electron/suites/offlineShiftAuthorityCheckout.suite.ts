import { deepEqual, equal, ok } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { DesktopApiClient } from '../../../src/main/http/desktopApiClient'
import { handleIpcRequest } from '../../../src/main/ipc/handleIpcRequest'
import { ShiftPermissions } from '../../../src/main/services/shiftPermissions'
import { ShiftService } from '../../../src/main/services/shift.service'
import type { CommercialAccessService } from '../../../src/main/services/commercialAccess.service'
import {
  checkoutCompleteInputSchema,
  shiftsCurrentInputSchema,
  shiftsLocalAuthorityInputSchema
} from '../../../src/shared/validators/ipc.validators'
import { shiftLocalAuthoritySchema } from '../../../src/shared/contracts/shiftAuthority.contract'
import type { CheckoutIntent } from '../../../src/shared/contracts/checkout.contract'
import { databaseTest, type DatabaseSandbox } from '../support/sandbox'
import { readCommitted } from '../support/committedState'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'
import {
  bootstrapResource,
  companyUuid,
  deviceUuid,
  methodUuid,
  productUuid,
  setUpAuthorizedContext,
  shiftUuid,
  trackedProductUuid,
  validIntent,
  warehouseUuid
} from '../support/localSaleFixture'

/**
 * E1: the main-process half of "Laravel stopped while Electron kept running". `shifts:current`
 * cannot answer, but the durable owner-scoped observation still can — and it is the *same* record
 * `checkout:complete` resolves, so the renderer gate built on it can never out-permit the sell
 * guard. A loopback port nothing is listening on reproduces the refused connection exactly.
 */
const UNREACHABLE_ORIGIN = new URL('http://127.0.0.1:59117')
const ATTEMPT_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function unreachableShiftService(
  repositories: RealRepositories,
  authority: Parameters<typeof buildShiftService>[1]
): ShiftService {
  return buildShiftService(repositories, authority)
}

function buildShiftService(
  repositories: RealRepositories,
  authority: ConstructorParameters<typeof ShiftService>[3]
): ShiftService {
  return new ShiftService(
    new DesktopApiClient({
      apiOrigin: UNREACHABLE_ORIGIN,
      getAccessToken: () => 'desktop-token',
      getDeviceUuid: () => deviceUuid,
      timeoutMs: 2000
    }),
    { assertAllowed: () => undefined } as unknown as CommercialAccessService,
    new ShiftPermissions(repositories.bootstrapSnapshot),
    authority
  )
}

/** One service line (never allocation-checked) plus one allocated tracked line. */
function offlineCartIntent(): CheckoutIntent {
  return validIntent({
    items: [
      { id: 'item-1', productUuid, quantity: '1.000', discountType: null, discountValue: 0 },
      {
        id: 'item-2',
        productUuid: trackedProductUuid,
        quantity: '2.000',
        discountType: null,
        discountValue: 0
      }
    ],
    payments: [{ id: 'payment-1', paymentMethodUuid: methodUuid, amount: 2000, reference: null }]
  })
}

function grantAllocation(repositories: RealRepositories): void {
  repositories.stockAllocations.upsertGrant({
    allocationUuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    contractVersion: 1,
    companyUuid,
    deviceUuid,
    warehouseUuid,
    productUuid: trackedProductUuid,
    serverSequence: 1,
    lifecycleGeneration: 1,
    grantedQuantityMilli: 3000,
    consumeUntil: '2027-01-01T00:00:00.000Z',
    envelopeHash: 'a'.repeat(64),
    receivedAt: '2026-01-01T00:00:00.000Z'
  })
}

function invoiceCounts(sandbox: DatabaseSandbox): { invoices: number; queued: number } {
  return {
    invoices: readCommitted(sandbox, 'SELECT * FROM local_invoices').length,
    queued: readCommitted(sandbox, "SELECT * FROM sync_queue WHERE aggregate_type = 'invoice'")
      .length
  }
}

databaseTest(
  'with the API unreachable, shifts:current fails on transport while shifts:local-authority still admits the sale',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      // The shared fixture grants only pos.* rights; reading shift state — remote or local — is
      // gated on `shifts.view`, exactly as the production wiring gates it.
      repositories.bootstrapSnapshot.persistSnapshot(
        bootstrapResource({ permissions: ['pos.view', 'pos.sell', 'shifts.view'] }),
        '2026-01-01T00:01:00+00:00'
      )
      const { localSale, authority } = setUpAuthorizedContext(
        database,
        repositories,
        undefined,
        'offline'
      )
      grantAllocation(repositories)
      const shifts = unreachableShiftService(repositories, authority)

      // A. the refresh the renderer performs on mount, against a backend that is not listening.
      const refreshed = await handleIpcRequest(undefined, shiftsCurrentInputSchema, () =>
        shifts.current()
      )
      equal(refreshed.ok, false)
      ok(!refreshed.ok)
      equal(refreshed.error.category, 'transport')
      equal(refreshed.error.retryable, true)
      // No HTTP response ever arrived, so there is no status to branch on — the very case the
      // 5xx-shaped store test never covered.
      equal(refreshed.error.httpStatus, undefined)

      // B. the durable verdict the renderer now falls back to. Same record, no network.
      const local = await handleIpcRequest(undefined, shiftsLocalAuthorityInputSchema, () =>
        shifts.localAuthority()
      )
      ok(local.ok)
      deepEqual(shiftLocalAuthoritySchema.parse(local.data), {
        kind: 'open',
        shiftUuid,
        observedAt: '2026-01-01T01:00:00.000Z'
      })

      // C. the sale the renderer gate now permits actually commits, through the validated
      // `checkout:complete` payload contract — one service line, one allocated tracked line.
      const completed = await handleIpcRequest(
        { attemptKey: ATTEMPT_KEY, intent: offlineCartIntent() },
        checkoutCompleteInputSchema,
        (input) => localSale.complete(input.attemptKey, input.intent)
      )
      ok(completed.ok)
      equal(completed.data.outcome, 'committed')
      deepEqual(invoiceCounts(sandbox), { invoices: 1, queued: 1 })
      // The service line consumed no allocation; only the tracked line did.
      equal(readCommitted(sandbox, 'SELECT * FROM local_stock_allocation_consumptions').length, 1)
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'every non-open local authority denies the sale while the API is unreachable',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      // The shared fixture grants only pos.* rights; reading shift state — remote or local — is
      // gated on `shifts.view`, exactly as the production wiring gates it.
      repositories.bootstrapSnapshot.persistSnapshot(
        bootstrapResource({ permissions: ['pos.view', 'pos.sell', 'shifts.view'] }),
        '2026-01-01T00:01:00+00:00'
      )
      const { localSale, authority } = setUpAuthorizedContext(
        database,
        repositories,
        undefined,
        'offline'
      )
      grantAllocation(repositories)
      const shifts = unreachableShiftService(repositories, authority)
      const context = authority.captureContext()

      const cases = [
        {
          label: 'paused',
          write: () =>
            repositories.shiftObservations.write({
              kind: 'shift',
              ...context,
              shiftUuid,
              status: 'paused',
              openedAt: '2026-01-01T00:00:00.000Z',
              observedAt: '2026-01-01T01:00:00.000Z',
              source: 'pause'
            }),
          expected: { kind: 'not-open', status: 'paused' }
        },
        {
          label: 'closed',
          write: () =>
            repositories.shiftObservations.write({
              kind: 'shift',
              ...context,
              shiftUuid,
              status: 'closed',
              openedAt: '2026-01-01T00:00:00.000Z',
              observedAt: '2026-01-01T01:00:00.000Z',
              source: 'close'
            }),
          expected: { kind: 'not-open', status: 'closed' }
        },
        {
          label: 'authoritative no shift',
          write: () =>
            repositories.shiftObservations.write({
              kind: 'none',
              ...context,
              observedAt: '2026-01-01T01:00:00.000Z',
              source: 'current'
            }),
          expected: { kind: 'none', observedAt: '2026-01-01T01:00:00.000Z' }
        },
        {
          label: 'reconciliation required',
          write: () =>
            repositories.shiftObservations.write({
              kind: 'reconciliation_required',
              ...context,
              observedAt: '2026-01-01T01:00:00.000Z',
              source: 'open'
            }),
          expected: { kind: 'reconciliation-required', since: '2026-01-01T01:00:00.000Z' }
        },
        {
          label: 'a foreign owner/session',
          write: () =>
            repositories.shiftObservations.write({
              kind: 'shift',
              ...context,
              sessionEpoch: context.sessionEpoch + 1,
              shiftUuid,
              status: 'open',
              openedAt: '2026-01-01T00:00:00.000Z',
              observedAt: '2026-01-01T01:00:00.000Z',
              source: 'current'
            }),
          expected: { kind: 'foreign' }
        }
      ] as const

      let attempt = 0

      for (const testCase of cases) {
        testCase.write()
        const local = await handleIpcRequest(undefined, shiftsLocalAuthorityInputSchema, () =>
          shifts.localAuthority()
        )
        ok(local.ok, testCase.label)
        deepEqual(local.data, testCase.expected, testCase.label)

        attempt += 1
        const completed = await handleIpcRequest(
          {
            attemptKey: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${attempt}`,
            intent: offlineCartIntent()
          },
          checkoutCompleteInputSchema,
          (input) => localSale.complete(input.attemptKey, input.intent)
        )
        ok(completed.ok, testCase.label)
        // Whatever the precise denial code, no non-open authority may ever commit or queue a sale.
        ok(completed.data.outcome !== 'committed', testCase.label)
        deepEqual(invoiceCounts(sandbox), { invoices: 0, queued: 0 }, testCase.label)
      }
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'reconnecting replays the same attempt without duplicating the queued invoice',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const repositories = realRepositories(database)
      // The shared fixture grants only pos.* rights; reading shift state — remote or local — is
      // gated on `shifts.view`, exactly as the production wiring gates it.
      repositories.bootstrapSnapshot.persistSnapshot(
        bootstrapResource({ permissions: ['pos.view', 'pos.sell', 'shifts.view'] }),
        '2026-01-01T00:01:00+00:00'
      )
      const { localSale, authority } = setUpAuthorizedContext(
        database,
        repositories,
        undefined,
        'offline'
      )
      grantAllocation(repositories)
      const shifts = unreachableShiftService(repositories, authority)

      const first = await handleIpcRequest(
        { attemptKey: ATTEMPT_KEY, intent: offlineCartIntent() },
        checkoutCompleteInputSchema,
        (input) => localSale.complete(input.attemptKey, input.intent)
      )
      ok(first.ok)
      equal(first.data.outcome, 'committed')
      deepEqual(invoiceCounts(sandbox), { invoices: 1, queued: 1 })

      // The backend returns. `shifts:current` is authoritative again and rewrites the observation;
      // the offline sale must neither be re-committed nor re-queued.
      const context = authority.captureContext()
      repositories.shiftObservations.write({
        kind: 'shift',
        ...context,
        shiftUuid,
        status: 'open',
        openedAt: '2026-01-01T00:00:00.000Z',
        observedAt: '2026-01-01T02:00:00.000Z',
        source: 'current'
      })

      const local = await handleIpcRequest(undefined, shiftsLocalAuthorityInputSchema, () =>
        shifts.localAuthority()
      )
      ok(local.ok)
      equal(local.data.kind, 'open')

      const replay = await handleIpcRequest(
        { attemptKey: ATTEMPT_KEY, intent: offlineCartIntent() },
        checkoutCompleteInputSchema,
        (input) => localSale.complete(input.attemptKey, input.intent)
      )
      ok(replay.ok)
      deepEqual(invoiceCounts(sandbox), { invoices: 1, queued: 1 })
    } finally {
      closeDatabase(database)
    }
  }
)
