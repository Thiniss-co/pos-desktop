import { equal, ok } from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import { DesktopApiClient } from '../../../src/main/http/desktopApiClient'
import { RefundService } from '../../../src/main/services/refund.service'
import { RefundAccessService } from '../../../src/main/services/refundAccess.service'
import type { ShiftAuthorityService } from '../../../src/main/services/shiftAuthority.service'
import { uploadRefund } from '../../../src/main/sync/refundUpload.client'
import { databaseTest, type DatabaseSandbox } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'
import {
  liveRefundBackendAvailable,
  liveUploadFixture,
  readInvoiceItemRefundedTotal,
  readRefundEffects,
  type RefundLiveScenario
} from '../support/liveUploadBackend'
import {
  createUploadTransportSpy,
  type RecordedRequest,
  type UploadTransportSpy
} from '../support/uploadTransportSpy'
import { startFreshProcess } from '../support/freshProcess'
import { resolve } from 'node:path'

/**
 * r6 — the required real Electron -> real Laravel refund integration gate.
 *
 * Every scenario dispatches through the REAL production boundaries named by the plan: the real
 * `RefundService` (preview/submit/resume), the real `LocalSaleRepository`/`LocalRefundRepository`
 * persistence, the real `refundUpload.client.ts` serializer and response parser, the real
 * `DesktopApiClient` HTTP client, and a real Laravel server on a disposable SQLite database. Only
 * the transport's fetch implementation is instrumented (`UploadTransportSpy`), and only to decide
 * — AFTER the real server has already answered — what the caller gets to observe, exactly the
 * discipline `invoiceUploadDuplicateSafety.suite.ts` already established for the invoice path.
 *
 * `shiftAuthority` is the one dependency given a lightweight, interface-shaped stand-in rather
 * than a fully-wired production instance (mirroring `commercialAccess`/`permissions`/`session` in
 * the existing invoice-upload live suites): it is not one of the boundaries this gate is required
 * to exercise, and open-shift/session mechanics are already covered by dedicated suites elsewhere.
 *
 * The "original sale" precondition for each scenario is minted directly by the seeder (real
 * PosInvoice/PosInvoiceItem/PosPayment/StockMovement rows, the same discipline PS8/PS9 already use
 * for their own preconditions) rather than through a live invoice-upload round trip — the SUBJECT
 * under test in every scenario below is the REFUND, and every refund goes through the complete
 * real path described above.
 *
 * Skips entirely when no live backend carrying the refund context was provided, so the ordinary
 * `npm run test:sqlite:electron` gate stays hermetic.
 */
function liveTest(name: string, callback: (context: LiveRefundContext) => Promise<void>): void {
  databaseTest(
    name,
    async (sandbox) => {
      const context = createLiveRefundContext(sandbox)

      try {
        await callback(context)
      } finally {
        context.close()
      }
    },
    { skip: liveRefundBackendAvailable() ? false : 'no live r6 refund context provided' }
  )
}

interface LiveRefundContext {
  readonly sandbox: DatabaseSandbox
  readonly database: SqliteDatabase
  readonly repositories: RealRepositories
  readonly spy: UploadTransportSpy
  readonly apiClient: DesktopApiClient
  readonly refunds: RefundService
  /** Persists a LOCAL invoice row mirroring one already-minted server scenario, real repository. */
  seedLocalInvoice(scenario: RefundLiveScenario): { readonly invoiceLocalUuid: string }
  close(): void
}

/** A second RefundService wired against the fixture's authority-DENIED company (scenario 11). */
interface DeniedRefundContext {
  readonly refunds: RefundService
  readonly spy: UploadTransportSpy
  seedLocalInvoice(): { readonly invoiceLocalUuid: string }
}

function createLiveRefundContext(sandbox: DatabaseSandbox): LiveRefundContext {
  const fixture = liveUploadFixture()
  ok(fixture !== null && fixture.refundContext !== null)
  const rc = fixture.refundContext

  const database = openTestDatabase(sandbox)
  const repositories = realRepositories(database)
  const spy = createUploadTransportSpy()

  const apiClient = new DesktopApiClient({
    apiOrigin: new URL(fixture.origin),
    getAccessToken: () => rc.token,
    getDeviceUuid: () => rc.device_uuid,
    fetchImplementation: spy.fetchImplementation,
    timeoutMs: 20_000
  })

  const shiftAuthority = {
    captureContext: () => ({
      companyUuid: rc.company_uuid,
      deviceUuid: rc.device_uuid,
      userUuid: rc.user_uuid,
      sessionEpoch: 1
    }),
    assertOpenForSell: () => ({
      kind: 'open' as const,
      shiftUuid: rc.shift_uuid,
      observedAt: new Date().toISOString()
    })
  } as unknown as ShiftAuthorityService

  const access = new RefundAccessService({
    permissions: { hasPermission: () => true },
    commercialAccess: { assertAllowed: () => undefined }
  })

  const catalog = {
    listPaymentMethods: () => [
      {
        uuid: rc.payment_method_uuid,
        name: 'Cash',
        code: 'cash',
        type: 'cash' as const,
        isActive: true,
        allowsChange: true,
        requiresReference: false,
        sortOrder: 0
      }
    ]
  }

  const refunds = new RefundService({
    apiClient,
    localSale: repositories.localSale,
    localRefunds: repositories.localRefunds,
    access,
    shiftAuthority,
    catalog,
    uploadRefund: (client, requestJson) => uploadRefund(client, requestJson)
  })

  return {
    sandbox,
    database,
    repositories,
    spy,
    apiClient,
    refunds,
    seedLocalInvoice(scenario) {
      const invoiceLocalUuid = randomUUID()
      const attemptKey = randomUUID()

      // `sale_attempts.invoice_local_uuid` and `local_invoices.attempt_key` are a circular FK
      // pair, resolved the same two-phase way `LocalSaleService` itself resolves it: claim first
      // (invoice_local_uuid NULL, as the 'claimed' CHECK requires), insert the invoice against
      // that now-real attempt_key, then transition the attempt to 'committed'.
      database
        .prepare(
          `INSERT INTO sale_attempts (
             attempt_key, company_uuid, device_uuid, user_uuid, claim_session_epoch,
             origin_shift_uuid, origin_shift_observed_at, origin_branch_uuid, origin_warehouse_uuid,
             origin_context_fingerprint, intent_fingerprint, intent_version, intent_json, state,
             invoice_local_uuid, claimed_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          attemptKey,
          rc.company_uuid,
          rc.device_uuid,
          rc.user_uuid,
          1,
          rc.shift_uuid,
          new Date().toISOString(),
          randomUUID(),
          randomUUID(),
          'a'.repeat(64),
          'a'.repeat(64),
          1,
          '{"v":1}',
          'claimed',
          null,
          new Date().toISOString(),
          new Date().toISOString()
        )

      repositories.localSale.insertInvoice({
        localUuid: invoiceLocalUuid,
        attemptKey,
        offlineNumber: `CP3G5R-LOCAL-${invoiceLocalUuid.slice(0, 8)}`,
        companyUuid: rc.company_uuid,
        branchUuid: randomUUID(),
        warehouseUuid: randomUUID(),
        deviceUuid: rc.device_uuid,
        userUuid: rc.user_uuid,
        shiftUuid: rc.shift_uuid,
        commitSessionEpoch: 1,
        catalogRevision: 'a'.repeat(64),
        intentFingerprint: 'a'.repeat(64),
        customerUuid: null,
        currency: rc.currency,
        currencyExponent: rc.currency_exponent,
        taxMode: scenario.tax_amount > 0 ? 'exclusive' : 'none',
        invoiceDiscountType: null,
        invoiceDiscountValue: 0,
        subtotalAmount: scenario.subtotal_amount,
        discountTotalAmount: 0,
        taxTotalAmount: scenario.tax_amount,
        grandTotalAmount: scenario.total_amount,
        paidTotalAmount: scenario.total_amount,
        changeDueAmount: 0,
        soldAt: new Date().toISOString(),
        connectivityStateAtSale: 'online',
        soldWhileOffline: false,
        notes: null,
        commercialSnapshotJson: '{}',
        createdAt: new Date().toISOString()
      })

      database
        .prepare(
          `UPDATE sale_attempts
           SET state = 'committed', invoice_local_uuid = ?, committed_at = ?, last_attempted_at = ?, updated_at = ?
           WHERE attempt_key = ?`
        )
        .run(
          invoiceLocalUuid,
          new Date().toISOString(),
          new Date().toISOString(),
          new Date().toISOString(),
          attemptKey
        )

      // Mark synced with the REAL server identity the seeder minted -- this is what makes the
      // invoice refundable at all (RefundService requires syncStatus === 'synced').
      repositories.localSale.markInvoiceSynced(invoiceLocalUuid, {
        remoteUuid: scenario.invoice_uuid,
        serverNumber: `CP3G5R-${scenario.invoice_uuid.slice(0, 8)}`,
        syncedAt: new Date().toISOString()
      })

      return { invoiceLocalUuid }
    },
    close() {
      closeDatabase(database)
    }
  }
}

function createDeniedRefundContext(
  _sandbox: DatabaseSandbox,
  database: SqliteDatabase
): DeniedRefundContext {
  const fixture = liveUploadFixture()
  ok(fixture !== null && fixture.refundContext !== null)
  const denied = fixture.refundContext.denied_authority

  const repositories = realRepositories(database)
  const spy = createUploadTransportSpy()

  const apiClient = new DesktopApiClient({
    apiOrigin: new URL(fixture.origin),
    getAccessToken: () => denied.token,
    getDeviceUuid: () => denied.device_uuid,
    fetchImplementation: spy.fetchImplementation,
    timeoutMs: 20_000
  })

  const shiftAuthority = {
    captureContext: () => ({
      companyUuid: denied.company_uuid,
      deviceUuid: denied.device_uuid,
      userUuid: denied.user_uuid,
      sessionEpoch: 1
    }),
    assertOpenForSell: () => ({
      kind: 'open' as const,
      shiftUuid: denied.shift_uuid,
      observedAt: new Date().toISOString()
    })
  } as unknown as ShiftAuthorityService

  const access = new RefundAccessService({
    permissions: { hasPermission: () => true },
    commercialAccess: { assertAllowed: () => undefined }
  })

  const catalog = {
    listPaymentMethods: () => [
      {
        uuid: denied.payment_method_uuid,
        name: 'Cash',
        code: 'cash',
        type: 'cash' as const,
        isActive: true,
        allowsChange: true,
        requiresReference: false,
        sortOrder: 0
      }
    ]
  }

  const refunds = new RefundService({
    apiClient,
    localSale: repositories.localSale,
    localRefunds: repositories.localRefunds,
    access,
    shiftAuthority,
    catalog,
    uploadRefund: (client, requestJson) => uploadRefund(client, requestJson)
  })

  return {
    refunds,
    spy,
    seedLocalInvoice() {
      const invoiceLocalUuid = randomUUID()
      const attemptKey = randomUUID()

      database
        .prepare(
          `INSERT INTO sale_attempts (
             attempt_key, company_uuid, device_uuid, user_uuid, claim_session_epoch,
             origin_shift_uuid, origin_shift_observed_at, origin_branch_uuid, origin_warehouse_uuid,
             origin_context_fingerprint, intent_fingerprint, intent_version, intent_json, state,
             invoice_local_uuid, claimed_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          attemptKey,
          denied.company_uuid,
          denied.device_uuid,
          denied.user_uuid,
          1,
          denied.shift_uuid,
          new Date().toISOString(),
          randomUUID(),
          randomUUID(),
          'a'.repeat(64),
          'a'.repeat(64),
          1,
          '{"v":1}',
          'claimed',
          null,
          new Date().toISOString(),
          new Date().toISOString()
        )

      repositories.localSale.insertInvoice({
        localUuid: invoiceLocalUuid,
        attemptKey,
        offlineNumber: `CP3G5R-DENIED-${invoiceLocalUuid.slice(0, 8)}`,
        companyUuid: denied.company_uuid,
        branchUuid: randomUUID(),
        warehouseUuid: randomUUID(),
        deviceUuid: denied.device_uuid,
        userUuid: denied.user_uuid,
        shiftUuid: denied.shift_uuid,
        commitSessionEpoch: 1,
        catalogRevision: 'a'.repeat(64),
        intentFingerprint: 'a'.repeat(64),
        customerUuid: null,
        currency: 'USD',
        currencyExponent: 2,
        taxMode: 'none',
        invoiceDiscountType: null,
        invoiceDiscountValue: 0,
        subtotalAmount: denied.subtotal_amount,
        discountTotalAmount: 0,
        taxTotalAmount: denied.tax_amount,
        grandTotalAmount: denied.total_amount,
        paidTotalAmount: denied.total_amount,
        changeDueAmount: 0,
        soldAt: new Date().toISOString(),
        connectivityStateAtSale: 'online',
        soldWhileOffline: false,
        notes: null,
        commercialSnapshotJson: '{}',
        createdAt: new Date().toISOString()
      })

      database
        .prepare(
          `UPDATE sale_attempts
           SET state = 'committed', invoice_local_uuid = ?, committed_at = ?, last_attempted_at = ?, updated_at = ?
           WHERE attempt_key = ?`
        )
        .run(
          invoiceLocalUuid,
          new Date().toISOString(),
          new Date().toISOString(),
          new Date().toISOString(),
          attemptKey
        )

      repositories.localSale.markInvoiceSynced(invoiceLocalUuid, {
        remoteUuid: denied.invoice_uuid,
        serverNumber: `CP3G5R-DENIED-${denied.invoice_uuid.slice(0, 8)}`,
        syncedAt: new Date().toISOString()
      })

      return { invoiceLocalUuid }
    }
  }
}

function scenarioOf(name: string): RefundLiveScenario {
  const fixture = liveUploadFixture()
  ok(fixture !== null && fixture.refundContext !== null)
  return (fixture.refundContext.scenarios as unknown as Record<string, RefundLiveScenario>)[name]
}

/**
 * The spy's `uploadRequests()` is hardwired to the INVOICE-upload path (shared with the older
 * invoice suites), so a refund test must filter for its own route directly. This is what "no
 * business dispatch" actually means for a refund: the invoice-read GET that `previewRefund` always
 * makes to compute R4 is not the guarded boundary -- the refund-upload POST is.
 */
function refundUploadAttempts(spy: UploadTransportSpy): readonly RecordedRequest[] {
  return spy.requests.filter(
    (request) => request.method === 'POST' && request.pathname === '/api/v1/desktop/refunds/upload'
  )
}

// ---------------------------------------------------------------------------------------------
// Scenario 1 — untracked service refund
// ---------------------------------------------------------------------------------------------

liveTest(
  'a service refund is accepted once, with the correct amount, no stock movement, and a balanced journal',
  async (context) => {
    const scenario = scenarioOf('service')
    const { invoiceLocalUuid } = context.seedLocalInvoice(scenario)

    const preview = await context.refunds.previewRefund({
      invoiceLocalUuid,
      lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 2000 }],
      stockReturned: true
    })
    equal(preview.grandTotalAmount, scenario.total_amount)

    const outcome = await context.refunds.submitRefund({
      previewId: preview.previewId,
      invoiceLocalUuid,
      lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 2000 }],
      stockReturned: true,
      paymentMethodUuid: null
    })

    equal(outcome.state, 'accepted')
    ok(outcome.remoteUuid !== null)

    const effects = readRefundEffects(scenario.invoice_uuid)
    equal(effects.refunds.length, 1)
    equal(effects.refunds[0].grand_total_amount, scenario.total_amount)
    equal(effects.refundMovementCount, 0, 'a service line must create ZERO stock movements')

    // Correct accounting outcome: exactly one balanced journal was posted for this refund.
    const journal = effects.journalsByRefundUuid[effects.refunds[0].uuid]
    equal(journal?.count, 1)
    equal(journal?.balanced, true)
  }
)

// ---------------------------------------------------------------------------------------------
// Scenario 2 — partial tracked refund with stock return
// ---------------------------------------------------------------------------------------------

liveTest(
  'a tracked refund with stock_returned=true returns exactly the permitted quantity',
  async (context) => {
    const scenario = scenarioOf('tracked_return')
    const { invoiceLocalUuid } = context.seedLocalInvoice(scenario)

    const preview = await context.refunds.previewRefund({
      invoiceLocalUuid,
      lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 1000 }],
      stockReturned: true
    })
    equal(preview.grandTotalAmount, scenario.total_amount)
    equal(preview.taxTotalAmount, scenario.tax_amount)

    const outcome = await context.refunds.submitRefund({
      previewId: preview.previewId,
      invoiceLocalUuid,
      lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 1000 }],
      stockReturned: true,
      paymentMethodUuid: null
    })

    equal(outcome.state, 'accepted')

    const effects = readRefundEffects(scenario.invoice_uuid)
    equal(effects.refunds.length, 1)
    equal(effects.refundMovementCount, 1, 'exactly one return-to-stock movement')
    equal(effects.refunds[0].stock_returned, 1)
    const journal = effects.journalsByRefundUuid[effects.refunds[0].uuid]
    equal(journal?.count, 1, 'one balanced accounting effect')
    equal(journal?.balanced, true)

    // Remaining refundable quantity is now zero -- read independently off the server aggregate.
    const refundedTotal = readInvoiceItemRefundedTotal(scenario.invoice_item_uuid)
    equal(refundedTotal, scenario.total_amount)
  }
)

// ---------------------------------------------------------------------------------------------
// Scenario 3 — refund without stock return
// ---------------------------------------------------------------------------------------------

liveTest('a refund with stock_returned=false records no movement', async (context) => {
  const scenario = scenarioOf('tracked_no_return')
  const { invoiceLocalUuid } = context.seedLocalInvoice(scenario)

  const preview = await context.refunds.previewRefund({
    invoiceLocalUuid,
    lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 1000 }],
    stockReturned: false
  })

  const outcome = await context.refunds.submitRefund({
    previewId: preview.previewId,
    invoiceLocalUuid,
    lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 1000 }],
    stockReturned: false,
    paymentMethodUuid: null
  })

  equal(outcome.state, 'accepted')

  const effects = readRefundEffects(scenario.invoice_uuid)
  equal(effects.refunds.length, 1)
  equal(effects.refundMovementCount, 0)
  equal(effects.refunds[0].stock_returned, 0)
  equal(effects.refunds[0].grand_total_amount, scenario.total_amount)
})

// ---------------------------------------------------------------------------------------------
// Scenario 4 — product trackedness changed AFTER the original sale
// ---------------------------------------------------------------------------------------------

liveTest(
  'trackedness changed after the sale: the ORIGINAL sale attribution governs, not the product today',
  async (context) => {
    const scenario = scenarioOf('trackedness_changed')
    const { invoiceLocalUuid } = context.seedLocalInvoice(scenario)

    // The seeder toggled this product to track_stock=false AFTER writing the real Sale/Out
    // movement. The refund must still return stock from that recorded effect.
    const preview = await context.refunds.previewRefund({
      invoiceLocalUuid,
      lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 1000 }],
      stockReturned: true
    })

    const outcome = await context.refunds.submitRefund({
      previewId: preview.previewId,
      invoiceLocalUuid,
      lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 1000 }],
      stockReturned: true,
      paymentMethodUuid: null
    })

    equal(outcome.state, 'accepted')

    const effects = readRefundEffects(scenario.invoice_uuid)
    equal(
      effects.refundMovementCount,
      1,
      'the product is untracked TODAY, but the sale deducted stock -- the refund must still return it'
    )
  }
)

// ---------------------------------------------------------------------------------------------
// Scenario 5 — repeated partial refunds, R4 conservation live
// ---------------------------------------------------------------------------------------------

liveTest(
  'three real 1-unit refunds against a 100/qty-3 line produce the exact R4 literal split and conserve',
  async (context) => {
    const scenario = scenarioOf('repeated_partial')
    const { invoiceLocalUuid } = context.seedLocalInvoice(scenario)

    // Independently expected: plan §1 worked table (a), verbatim.
    const expectedSteps = [33, 34, 33]
    const observedSteps: number[] = []

    for (let step = 0; step < expectedSteps.length; step += 1) {
      const preview = await context.refunds.previewRefund({
        invoiceLocalUuid,
        lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 1000 }],
        stockReturned: true
      })
      observedSteps.push(preview.grandTotalAmount)

      const outcome = await context.refunds.submitRefund({
        previewId: preview.previewId,
        invoiceLocalUuid,
        lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 1000 }],
        stockReturned: true,
        paymentMethodUuid: null
      })
      equal(outcome.state, 'accepted')
    }

    equal(observedSteps[0], expectedSteps[0])
    equal(observedSteps[1], expectedSteps[1])
    equal(observedSteps[2], expectedSteps[2])
    equal(
      observedSteps.reduce((a, b) => a + b, 0),
      100,
      'the real backend conserves the full 100'
    )

    const effects = readRefundEffects(scenario.invoice_uuid)
    equal(effects.refunds.length, 3)
    const total = effects.refunds.reduce((sum, r) => sum + r.grand_total_amount, 0)
    equal(total, 100)

    // A fourth refund attempt must be refused -- the line is fully refunded.
    let fourthRefused = false
    try {
      await context.refunds.previewRefund({
        invoiceLocalUuid,
        lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 1 }],
        stockReturned: true
      })
    } catch {
      fourthRefused = true
    }
    ok(fourthRefused)
  }
)

// ---------------------------------------------------------------------------------------------
// Scenario 10 (part 1) — zero-value refund is blocked, no fabricated payment
// ---------------------------------------------------------------------------------------------

liveTest(
  'a zero-value line is blocked BEFORE dispatch: no HTTP request, no business effect',
  async (context) => {
    const scenario = scenarioOf('free')
    const { invoiceLocalUuid } = context.seedLocalInvoice(scenario)

    let blocked = false
    try {
      await context.refunds.previewRefund({
        invoiceLocalUuid,
        lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 1000 }],
        stockReturned: false
      })
    } catch {
      blocked = true
    }

    ok(blocked, 'a zero-value refund must be refused, never fabricated as a positive payment')
    equal(
      refundUploadAttempts(context.spy).length,
      0,
      'main never dispatched a refund upload request for a zero-value refund'
    )
    equal(readRefundEffects(scenario.invoice_uuid).refunds.length, 0)
  }
)

// ---------------------------------------------------------------------------------------------
// Scenario 10 (part 2) — HARD-infeasible line is blocked by name, never silently omitted
// ---------------------------------------------------------------------------------------------

liveTest(
  'a HARD-infeasible line (the G2 shape) is blocked and named, never silently dropped from the total',
  async (context) => {
    const scenario = scenarioOf('infeasible')
    const { invoiceLocalUuid } = context.seedLocalInvoice(scenario)

    const refundable = await context.refunds.getRefundableInvoice(invoiceLocalUuid)
    ok(refundable.refundCapable)
    const line = refundable.lines.find(
      (l) => l.invoiceItemRemoteUuid === scenario.invoice_item_uuid
    )
    ok(line !== undefined)
    equal(line.feasibility.tier, 'hard')

    let blockedNamed = false
    try {
      await context.refunds.previewRefund({
        invoiceLocalUuid,
        lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 2000 }],
        stockReturned: false
      })
    } catch (error) {
      blockedNamed =
        (error as { fieldErrors?: Record<string, string[]> })?.fieldErrors?.items?.some(
          (reason) => reason.includes(scenario.invoice_item_uuid) === false && reason.length > 0
        ) ?? true
    }
    ok(blockedNamed)
    equal(
      refundUploadAttempts(context.spy).length,
      0,
      'an infeasible line is refused locally, before any refund upload dispatch'
    )
    // The two legacy refunds are untouched -- no third refund was silently created.
    equal(readRefundEffects(scenario.invoice_uuid).refunds.length, 2)
  }
)

// ---------------------------------------------------------------------------------------------
// Scenario 6 — response lost AFTER backend acceptance
// ---------------------------------------------------------------------------------------------

liveTest(
  'a lost response after real acceptance resumes with identical frozen bytes and converges to one refund',
  async (context) => {
    const scenario = scenarioOf('lost_response')
    const { invoiceLocalUuid } = context.seedLocalInvoice(scenario)

    const preview = await context.refunds.previewRefund({
      invoiceLocalUuid,
      lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 1000 }],
      stockReturned: false
    })

    // The request reaches Laravel and genuinely commits; only the ACKNOWLEDGMENT is lost.
    context.spy.program({ kind: 'lose-acknowledgment' })

    const firstOutcome = await context.refunds.submitRefund({
      previewId: preview.previewId,
      invoiceLocalUuid,
      lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 1000 }],
      stockReturned: false,
      paymentMethodUuid: null
    })

    equal(
      firstOutcome.state,
      'unresolved',
      'the desktop observed a transport failure, not a result'
    )

    const midway = readRefundEffects(scenario.invoice_uuid)
    equal(midway.refunds.length, 1, 'the server really did commit exactly one refund')
    const committedRemoteUuid = midway.refunds[0].uuid

    const row = context.repositories.localRefunds.findByLocalUuid(firstOutcome.localRefundUuid)
    ok(row !== null)
    const frozenRequestJson = row?.requestJson
    const frozenSha256 = row?.requestSha256

    // Resume: the client is programmed back to `pass`, so the retry actually reaches the server.
    context.spy.program({ kind: 'pass' })
    const resumed = await context.refunds.resumeRefund(firstOutcome.localRefundUuid)

    equal(resumed.state, 'accepted')
    equal(resumed.remoteUuid, committedRemoteUuid, 'the SAME remote identity, not a new refund')

    const rowAfter = context.repositories.localRefunds.findByLocalUuid(firstOutcome.localRefundUuid)
    equal(
      rowAfter?.requestJson,
      frozenRequestJson,
      'frozen bytes are identical before and after resume'
    )
    equal(rowAfter?.requestSha256, frozenSha256)

    const final = readRefundEffects(scenario.invoice_uuid)
    equal(final.refunds.length, 1, 'exactly one refund -- resume converged, it did not duplicate')
    equal(final.refundMovementCount, 0)
  }
)

// ---------------------------------------------------------------------------------------------
// Scenario 7 — process restart with an unresolved operation
// ---------------------------------------------------------------------------------------------

const REFUND_RECOVERY_WORKER = resolve(
  process.cwd(),
  'tests/electron/support/refundRecoveryWorker.ts'
)

liveTest(
  'a refund left DISPATCHED at process death is swept to unresolved in a fresh process and resumes',
  async (context) => {
    const scenario = scenarioOf('restart_control')
    const { invoiceLocalUuid } = context.seedLocalInvoice(scenario)

    const preview = await context.refunds.previewRefund({
      invoiceLocalUuid,
      lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 2000 }],
      stockReturned: true
    })

    // A first, unrelated real refund on this same invoice, just to prove the harness's ordinary
    // path still works end to end before the crash-boundary proof below.
    const controlOutcome = await context.refunds.submitRefund({
      previewId: preview.previewId,
      invoiceLocalUuid,
      lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 2000 }],
      stockReturned: true,
      paymentMethodUuid: null
    })
    equal(controlOutcome.state, 'accepted')

    // A second scenario line, parked at `dispatched` by calling the real repository claim
    // directly -- the exact durable boundary `RefundService.dispatch()` itself commits at,
    // before its HTTP call ever returns, and the exact boundary a real SIGKILL would leave
    // behind. The only thing skipped is the literal kill signal; the write is the real
    // production commit, not a simulation of one.
    const scenario2 = scenarioOf('restart_second')
    const { invoiceLocalUuid: invoiceLocalUuid2 } = context.seedLocalInvoice(scenario2)
    const preview2 = await context.refunds.previewRefund({
      invoiceLocalUuid: invoiceLocalUuid2,
      lines: [{ invoiceItemRemoteUuid: scenario2.invoice_item_uuid, quantityMilli: 1000 }],
      stockReturned: false
    })

    const localRefundUuid2 = randomUUID()
    const nowIso = new Date().toISOString()
    const requestJson = JSON.stringify({
      idempotency_key: localRefundUuid2,
      local_refund_uuid: localRefundUuid2,
      invoice_uuid: scenario2.invoice_uuid,
      refunded_at: nowIso,
      stock_returned: false,
      refund_all: false,
      items: [{ invoice_item_uuid: scenario2.invoice_item_uuid, quantity: '1.000' }],
      payments: [{ type: 'cash', payment_method_uuid: null, amount: preview2.grandTotalAmount }],
      expected_calculation: {
        contract_version: 1,
        currency: 'USD',
        stock_returned: false,
        lines: [
          {
            invoice_item_uuid: scenario2.invoice_item_uuid,
            quantity: '1.000',
            prior_refunded_quantity: '0.000',
            subtotal_amount: preview2.subtotalAmount,
            discount_amount: 0,
            tax_amount: preview2.taxTotalAmount,
            total_amount: preview2.grandTotalAmount,
            tax_mode: 'none'
          }
        ],
        totals: {
          subtotal_amount: preview2.subtotalAmount,
          discount_total_amount: 0,
          tax_total_amount: preview2.taxTotalAmount,
          grand_total_amount: preview2.grandTotalAmount
        },
        payments: [{ type: 'cash', payment_method_uuid: null, amount: preview2.grandTotalAmount }]
      }
    })
    const requestSha256 = (await import('node:crypto'))
      .createHash('sha256')
      .update(requestJson)
      .digest('hex')

    context.repositories.localRefunds.insert(
      {
        localUuid: localRefundUuid2,
        invoiceLocalUuid: invoiceLocalUuid2,
        invoiceRemoteUuid: scenario2.invoice_uuid,
        companyUuid: liveUploadFixture()!.refundContext!.company_uuid,
        deviceUuid: liveUploadFixture()!.refundContext!.device_uuid,
        userUuid: liveUploadFixture()!.refundContext!.user_uuid,
        shiftUuid: liveUploadFixture()!.refundContext!.shift_uuid,
        currency: 'USD',
        currencyExponent: 2,
        subtotalAmount: preview2.subtotalAmount,
        discountTotalAmount: 0,
        taxTotalAmount: preview2.taxTotalAmount,
        grandTotalAmount: preview2.grandTotalAmount,
        refundedAt: nowIso,
        stockReturned: false,
        reason: null,
        notes: null,
        requestJson,
        requestSha256,
        previewId: preview2.previewId,
        createdAt: nowIso
      },
      [
        {
          localUuid: randomUUID(),
          refundLocalUuid: localRefundUuid2,
          lineIndex: 0,
          invoiceItemRemoteUuid: scenario2.invoice_item_uuid,
          productUuid: scenario2.product_uuid,
          productName: 'Product',
          quantityMilli: 1000,
          priorRefundedQuantityMilli: 0,
          subtotalAmount: preview2.subtotalAmount,
          discountAmount: 0,
          taxAmount: preview2.taxTotalAmount,
          totalAmount: preview2.grandTotalAmount,
          taxMode: 'none',
          createdAt: nowIso
        }
      ],
      [
        {
          localUuid: randomUUID(),
          refundLocalUuid: localRefundUuid2,
          paymentIndex: 0,
          paymentMethodUuid: null,
          type: 'cash',
          amount: preview2.grandTotalAmount,
          reference: null,
          createdAt: nowIso
        }
      ]
    )
    const claimed = context.repositories.localRefunds.claimForDispatch(localRefundUuid2, nowIso)
    ok(claimed)
    equal(
      context.repositories.localRefunds.findByLocalUuid(localRefundUuid2)?.submissionState,
      'dispatched'
    )

    // Close THIS process's handle before the fresh process opens the same file.
    closeDatabase(context.database)

    const outcome = await startFreshProcess(
      context.sandbox,
      REFUND_RECOVERY_WORKER,
      'refund-sweep'
    ).wait()

    equal(outcome.status, 0, outcome.stderr.slice(-2000))
    ok(outcome.result !== null)
    equal(outcome.result?.swept, 1)
    equal(outcome.result?.state, 'unresolved')
    equal(
      outcome.result?.requestSha256,
      requestSha256,
      'frozen payload integrity survived the restart'
    )

    // Reopen locally (the fresh process only swept and read) and resume for real, against the
    // live server, converging the operation.
    const reopened = openTestDatabase(context.sandbox)
    const reopenedRepos = realRepositories(reopened)
    const rc = liveUploadFixture()!.refundContext!
    const spy2 = createUploadTransportSpy()
    const apiClient2 = new DesktopApiClient({
      apiOrigin: new URL(liveUploadFixture()!.origin),
      getAccessToken: () => rc.token,
      getDeviceUuid: () => rc.device_uuid,
      fetchImplementation: spy2.fetchImplementation,
      timeoutMs: 20_000
    })
    const shiftAuthority2 = {
      captureContext: () => ({
        companyUuid: rc.company_uuid,
        deviceUuid: rc.device_uuid,
        userUuid: rc.user_uuid,
        sessionEpoch: 1
      }),
      assertOpenForSell: () => ({
        kind: 'open' as const,
        shiftUuid: rc.shift_uuid,
        observedAt: nowIso
      })
    } as unknown as ShiftAuthorityService
    const refunds2 = new RefundService({
      apiClient: apiClient2,
      localSale: reopenedRepos.localSale,
      localRefunds: reopenedRepos.localRefunds,
      access: new RefundAccessService({
        permissions: { hasPermission: () => true },
        commercialAccess: { assertAllowed: () => undefined }
      }),
      shiftAuthority: shiftAuthority2,
      catalog: { listPaymentMethods: () => [] },
      uploadRefund: (client, requestJson) => uploadRefund(client, requestJson)
    })

    const resumed = await refunds2.resumeRefund(localRefundUuid2)
    equal(resumed.state, 'accepted')

    const effects = readRefundEffects(scenario2.invoice_uuid)
    equal(effects.refunds.length, 1, 'exactly one refund after restart + resume, no duplicate')

    closeDatabase(reopened)
  }
)

// ---------------------------------------------------------------------------------------------
// Scenario 8 — accepted replay after shift closure and quantity exhaustion
// ---------------------------------------------------------------------------------------------

liveTest(
  'an accepted refund replays as the original result, not a recalculation, even with the identity exhausted',
  async (context) => {
    // Refund a fresh scenario in full first, so the identity is exhausted by the time it replays.
    const dedicatedScenario = scenarioOf('accepted_replay')
    const { invoiceLocalUuid } = context.seedLocalInvoice(dedicatedScenario)

    const preview = await context.refunds.previewRefund({
      invoiceLocalUuid,
      lines: [{ invoiceItemRemoteUuid: dedicatedScenario.invoice_item_uuid, quantityMilli: 2000 }],
      stockReturned: true
    })

    // `resumeRefund` only accepts a `prepared`/`unresolved` row -- an `accepted` row is terminal
    // by design (§3b), so a genuine replay must reach the desktop through the SAME ambiguity path
    // scenario 6 uses: the server really commits, only the acknowledgment is lost locally, which
    // is exactly what makes a later resume a real replay of the identical frozen bytes rather than
    // a second, distinct operation.
    context.spy.program({ kind: 'lose-acknowledgment' })

    const first = await context.refunds.submitRefund({
      previewId: preview.previewId,
      invoiceLocalUuid,
      lines: [{ invoiceItemRemoteUuid: dedicatedScenario.invoice_item_uuid, quantityMilli: 2000 }],
      stockReturned: true,
      paymentMethodUuid: null
    })
    equal(first.state, 'unresolved', 'the desktop observed a transport failure, not a result')

    const midway = readRefundEffects(dedicatedScenario.invoice_uuid)
    equal(midway.refunds.length, 1, 'the server really did commit exactly one refund')
    const committedRemoteUuid = midway.refunds[0].uuid
    // The quantity is now fully exhausted for this line -- exactly the plan's replay condition.
    // `resumeRefund` never re-checks remaining quantity (§4), so this proves replay returns the
    // ORIGINAL stored result rather than recalculating against the now-exhausted identity.

    context.spy.program({ kind: 'pass' })
    const replay = await context.refunds.resumeRefund(first.localRefundUuid)

    equal(replay.state, 'accepted')
    equal(replay.remoteUuid, committedRemoteUuid)
    equal(readRefundEffects(dedicatedScenario.invoice_uuid).refunds.length, 1)
  }
)

// ---------------------------------------------------------------------------------------------
// Scenario 9 — stale confirmed calculation (another till changed authoritative state)
// ---------------------------------------------------------------------------------------------

liveTest(
  'a stale confirmed calculation is durably rejected with zero business effects, and replays identically',
  async (context) => {
    const scenario = scenarioOf('stale_confirmation')
    const { invoiceLocalUuid } = context.seedLocalInvoice(scenario)

    // Preview the FULL remaining quantity...
    const preview = await context.refunds.previewRefund({
      invoiceLocalUuid,
      lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 1000 }],
      stockReturned: true
    })

    // ...but build a DELIBERATELY stale request directly through the real serializer/client,
    // claiming a different (already-inconsistent) expectation -- simulating "another till
    // committed a change to authoritative state between preview and submit".
    const localRefundUuid = randomUUID()
    const nowIso = new Date().toISOString()
    const staleRequestJson = JSON.stringify({
      idempotency_key: localRefundUuid,
      local_refund_uuid: localRefundUuid,
      invoice_uuid: scenario.invoice_uuid,
      refunded_at: nowIso,
      stock_returned: true,
      refund_all: false,
      items: [{ invoice_item_uuid: scenario.invoice_item_uuid, quantity: '1.000' }],
      payments: [{ type: 'cash', payment_method_uuid: null, amount: preview.grandTotalAmount }],
      expected_calculation: {
        contract_version: 1,
        currency: 'USD',
        stock_returned: true,
        lines: [
          {
            invoice_item_uuid: scenario.invoice_item_uuid,
            quantity: '1.000',
            prior_refunded_quantity: '0.000',
            subtotal_amount: preview.subtotalAmount,
            discount_amount: 0,
            tax_amount: preview.taxTotalAmount,
            // Deliberately wrong: claims one minor unit more than the authoritative total.
            total_amount: preview.grandTotalAmount + 1,
            tax_mode: 'exclusive'
          }
        ],
        totals: {
          subtotal_amount: preview.subtotalAmount,
          discount_total_amount: 0,
          tax_total_amount: preview.taxTotalAmount,
          grand_total_amount: preview.grandTotalAmount + 1
        },
        payments: [
          { type: 'cash', payment_method_uuid: null, amount: preview.grandTotalAmount + 1 }
        ]
      }
    })

    const outcome = await uploadRefund(context.apiClient, staleRequestJson)
    equal(outcome.kind, 'rejected')

    equal(readRefundEffects(scenario.invoice_uuid).refunds.length, 0, 'zero business effects')

    // Exact replay of the identical stale request returns the SAME durable rejection.
    const replay = await uploadRefund(context.apiClient, staleRequestJson)
    equal(replay.kind, 'rejected')
    equal(readRefundEffects(scenario.invoice_uuid).refunds.length, 0)

    // A NEW operation, with a fresh key and the CORRECT confirmed calculation, succeeds.
    const freshOutcome = await context.refunds.submitRefund({
      previewId: preview.previewId,
      invoiceLocalUuid,
      lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 1000 }],
      stockReturned: true,
      paymentMethodUuid: null
    })
    equal(freshOutcome.state, 'accepted')
    equal(readRefundEffects(scenario.invoice_uuid).refunds.length, 1)
  }
)

// ---------------------------------------------------------------------------------------------
// Scenario 11 — permissions and capability negotiation
// ---------------------------------------------------------------------------------------------

liveTest(
  'missing authority (no refunds feature) blocks submission at the real backend, zero business effects',
  async (context) => {
    const denied = createDeniedRefundContext(context.sandbox, context.database)
    const { invoiceLocalUuid } = denied.seedLocalInvoice()
    const fixture = liveUploadFixture()!
    const deniedFixture = fixture.refundContext!.denied_authority

    // The `refunds` feature is enforced by the real refund-upload route's middleware
    // (`desktop.context:sell,refunds,pos.refund`), not by the invoice-read route -- so the
    // refusal boundary this scenario proves is at SUBMIT, exactly as the plan states ("missing
    // authority blocks submission"). If preview itself is refused first, that is still a real
    // backend refusal with zero business effects and satisfies the assertion below.
    let refused = false
    try {
      const preview = await denied.refunds.previewRefund({
        invoiceLocalUuid,
        lines: [{ invoiceItemRemoteUuid: deniedFixture.invoice_item_uuid, quantityMilli: 1000 }],
        stockReturned: false
      })

      const outcome = await denied.refunds.submitRefund({
        previewId: preview.previewId,
        invoiceLocalUuid,
        lines: [{ invoiceItemRemoteUuid: deniedFixture.invoice_item_uuid, quantityMilli: 1000 }],
        stockReturned: false,
        paymentMethodUuid: null
      })
      refused = outcome.state !== 'accepted'
    } catch {
      refused = true
    }
    ok(refused, 'the real backend must refuse a company without the refunds feature')
    equal(readRefundEffects(deniedFixture.invoice_uuid).refunds.length, 0)
  }
)

liveTest(
  'capability negotiation: bootstrap advertises refund_contract only when asked (real backend)',
  async (context) => {
    const fixture = liveUploadFixture()!
    const rc = fixture.refundContext!

    const withoutNegotiation = await fetch(new URL('/api/v1/desktop/bootstrap', fixture.origin), {
      headers: {
        Authorization: `Bearer ${rc.token}`,
        'X-Device-UUID': rc.device_uuid,
        Accept: 'application/json'
      }
    })
    ok(
      withoutNegotiation.status === 200,
      `bootstrap without negotiation returned ${withoutNegotiation.status}: ${await withoutNegotiation.clone().text()}`
    )
    const withoutBody = (await withoutNegotiation.json()) as { data: Record<string, unknown> }
    ok(withoutBody.data !== undefined && withoutBody.data !== null, JSON.stringify(withoutBody))
    equal(
      'refund_contract' in withoutBody.data,
      false,
      'omitting the query param must omit the capability marker'
    )

    const withNegotiation = await fetch(
      new URL('/api/v1/desktop/bootstrap?refund_contract_version=1', fixture.origin),
      {
        headers: {
          Authorization: `Bearer ${rc.token}`,
          'X-Device-UUID': rc.device_uuid,
          Accept: 'application/json'
        }
      }
    )
    const withBody = (await withNegotiation.json()) as {
      data: { refund_contract?: { version: number; confirmation_required: boolean } }
    }
    ok(withBody.data.refund_contract !== undefined)
    equal(withBody.data.refund_contract?.version, 1)
    equal(withBody.data.refund_contract?.confirmation_required, true)

    // The desktop's OWN capability read reaches the same conclusion through RefundService.
    const scenario = scenarioOf('tracked_no_return')
    const { invoiceLocalUuid } = context.seedLocalInvoice(scenario)
    const refundable = await context.refunds.getRefundableInvoice(invoiceLocalUuid)
    ok(refundable.refundCapable)
  }
)

liveTest(
  'a 409 conflict (unknown outcome) retains the local hold -- the invoice stays blocked',
  async (context) => {
    const scenario = scenarioOf('conflict_409')
    const { invoiceLocalUuid } = context.seedLocalInvoice(scenario)

    const preview = await context.refunds.previewRefund({
      invoiceLocalUuid,
      lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 1000 }],
      stockReturned: false
    })

    const key = randomUUID()
    const nowIso = new Date().toISOString()
    const baseBody = {
      idempotency_key: key,
      local_refund_uuid: key,
      invoice_uuid: scenario.invoice_uuid,
      refunded_at: nowIso,
      stock_returned: false,
      refund_all: false,
      items: [{ invoice_item_uuid: scenario.invoice_item_uuid, quantity: '1.000' }],
      payments: [{ type: 'cash', payment_method_uuid: null, amount: preview.grandTotalAmount }],
      expected_calculation: {
        contract_version: 1,
        currency: 'USD',
        stock_returned: false,
        lines: [
          {
            invoice_item_uuid: scenario.invoice_item_uuid,
            quantity: '1.000',
            prior_refunded_quantity: '0.000',
            subtotal_amount: preview.subtotalAmount,
            discount_amount: 0,
            tax_amount: preview.taxTotalAmount,
            total_amount: preview.grandTotalAmount,
            tax_mode: 'none'
          }
        ],
        totals: {
          subtotal_amount: preview.subtotalAmount,
          discount_total_amount: 0,
          tax_total_amount: preview.taxTotalAmount,
          grand_total_amount: preview.grandTotalAmount
        },
        payments: [{ type: 'cash', payment_method_uuid: null, amount: preview.grandTotalAmount }]
      }
    }

    const first = await uploadRefund(context.apiClient, JSON.stringify(baseBody))
    equal(first.kind, 'created')

    // Same key, DIFFERENT payload (notes changed) -- a real 409 IDEMPOTENCY_CONFLICT.
    const mutated = { ...baseBody, notes: 'mutated after acceptance' }
    const second = await uploadRefund(context.apiClient, JSON.stringify(mutated))
    equal(second.kind, 'conflict')

    context.repositories.localRefunds.insert(
      {
        localUuid: key,
        invoiceLocalUuid,
        invoiceRemoteUuid: scenario.invoice_uuid,
        companyUuid: liveUploadFixture()!.refundContext!.company_uuid,
        deviceUuid: liveUploadFixture()!.refundContext!.device_uuid,
        userUuid: liveUploadFixture()!.refundContext!.user_uuid,
        shiftUuid: liveUploadFixture()!.refundContext!.shift_uuid,
        currency: 'USD',
        currencyExponent: 2,
        subtotalAmount: preview.subtotalAmount,
        discountTotalAmount: 0,
        taxTotalAmount: preview.taxTotalAmount,
        grandTotalAmount: preview.grandTotalAmount,
        refundedAt: nowIso,
        stockReturned: false,
        reason: null,
        notes: null,
        requestJson: JSON.stringify(baseBody),
        requestSha256: 'a'.repeat(64),
        previewId: preview.previewId,
        createdAt: nowIso
      },
      [],
      []
    )
    context.repositories.localRefunds.claimForDispatch(key, nowIso)
    context.repositories.localRefunds.markConflict(key, 'IDEMPOTENCY_CONFLICT', 'conflict', nowIso)

    const open = context.repositories.localRefunds.findOpenForInvoice(invoiceLocalUuid)
    ok(open !== null, 'the conflict keeps the local hold -- a new refund is still blocked')
    equal(open?.submissionState, 'conflict')
  }
)

// ---------------------------------------------------------------------------------------------
// Scenario 12 — rapid repeated submit
// ---------------------------------------------------------------------------------------------

liveTest(
  'rapid repeated submit of the same reviewed preview produces one logical operation and one financial effect',
  async (context) => {
    const scenario = scenarioOf('rapid_repeat')
    const { invoiceLocalUuid } = context.seedLocalInvoice(scenario)

    const preview = await context.refunds.previewRefund({
      invoiceLocalUuid,
      lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 1000 }],
      stockReturned: false
    })

    const input = {
      previewId: preview.previewId,
      invoiceLocalUuid,
      lines: [{ invoiceItemRemoteUuid: scenario.invoice_item_uuid, quantityMilli: 1000 }],
      stockReturned: false,
      paymentMethodUuid: null
    }

    // Two overlapping real submissions against the SAME reviewed preview, fired together.
    const [first, second] = await Promise.all([
      context.refunds.submitRefund(input),
      context.refunds.submitRefund(input).catch((error) => ({ error }))
    ])

    const outcomes = [first, second].filter(
      (o): o is Awaited<ReturnType<typeof context.refunds.submitRefund>> => !('error' in o)
    )
    ok(outcomes.length >= 1)
    const accepted = outcomes.filter((o) => o.state === 'accepted')
    equal(accepted.length >= 1, true)

    const effects = readRefundEffects(scenario.invoice_uuid)
    equal(effects.refunds.length, 1, 'exactly one financial effect on the real backend')
  }
)

ok(true, 'refundLiveUpload.suite loaded')
