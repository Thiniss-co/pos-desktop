import { existsSync, writeFileSync } from 'node:fs'

import { openSandboxDatabaseAtPath } from './openTestDatabase'
import { realRepositories } from './realRepositories'
import { setUpAuthorizedContext, trackedProductUuid, validIntent } from './localSaleFixture'
import { runSerializedWrite } from '../../../src/main/database/serializedWrite'
import {
  allocationJournalAppend,
  allocationJournalInitialHash
} from '../../../src/main/services/allocationJournal'

/**
 * BH-04B-3-R1 §2: the checkout-versus-reconciliation two-process proof, corrected.
 *
 * `hold-lock` and `probe-and-checkout`/`probe-only` replace the earlier fixed-sleep design. The
 * earlier design compared the coverer's write-transaction-acquisition timestamp against the
 * holder's insertion time plus a hardcoded hold duration — that inequality can be satisfied purely
 * by slow process startup, without the coverer ever having attempted its transaction while the
 * holder was open. It is not used any more.
 *
 * The corrected mechanism uses `PRAGMA busy_timeout = 0` from the competing process's own
 * connection to force an immediate, unambiguous `SQLITE_BUSY`/`SQLITE_LOCKED` at `BEGIN IMMEDIATE`
 * if — and only if — another connection currently holds the write lock. That is direct evidence of
 * contention at a specific instant, not an inference from wall-clock arithmetic. The probed
 * connection is the exact same one the production code (`LocalSaleService`, via
 * `runSerializedWrite`) goes on to use, and only after the probe is `busy_timeout` restored to the
 * production value (5000ms, set once by `connection.ts`) — so the subsequent production call blocks
 * and waits exactly as it does outside tests, rather than failing fast.
 *
 * `hold-lock` never inserts a synthetic row: `BEGIN IMMEDIATE` alone already takes the RESERVED
 * lock that blocks a second writer's `BEGIN IMMEDIATE` (SQLite's lock is acquired at `BEGIN
 * IMMEDIATE` itself, not deferred to the first write), so nothing further is needed to create real
 * contention. It holds until an explicit release file appears — never a fixed sleep — so the parent
 * fully controls when release happens, and can require contention to be observed first.
 */

const RESULT_PREFIX = '@@RESULT@@'

function emit(value: Record<string, unknown>): void {
  console.log(RESULT_PREFIX + JSON.stringify(value))
}

function blockingSleep(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // Deliberate synchronous spin — this worker has no event loop work to yield to here.
  }
}

/** A bounded failure guard only — never the release condition itself. */
function waitForFileSync(path: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${path}`)
    }
    blockingSleep(5)
  }
}

const databasePath = process.env.POS_ITEST_DB_PATH
const command = process.env.POS_ITEST_COMMAND

if (!databasePath || !command) {
  throw new Error('allocationConcurrencyWorker requires POS_ITEST_DB_PATH and POS_ITEST_COMMAND')
}

const database = openSandboxDatabaseAtPath(databasePath)

try {
  switch (command) {
    /**
     * Holds the real write lock open — `BEGIN IMMEDIATE`, no subsequent write needed — until the
     * parent writes `POS_ITEST_RELEASE_PATH`. The parent only writes that file after independently
     * confirming (via `probe-and-checkout`'s or `probe-only`'s busy probe) that a competing
     * connection actually observed this lock.
     */
    case 'hold-lock': {
      const markerPath = process.env.POS_ITEST_MARKER_PATH
      const releasePath = process.env.POS_ITEST_RELEASE_PATH
      if (!markerPath || !releasePath) {
        throw new Error('hold-lock requires POS_ITEST_MARKER_PATH and POS_ITEST_RELEASE_PATH')
      }

      database.exec('BEGIN IMMEDIATE')
      const acquiredAt = Date.now()
      writeFileSync(markerPath, JSON.stringify({ holding: true, acquiredAt }))

      waitForFileSync(releasePath, 15_000)

      database.exec('COMMIT')
      emit({ outcome: 'released', acquiredAt, releasedAt: Date.now() })
      break
    }

    case 'hold-recovery-intent': {
      const markerPath = process.env.POS_ITEST_MARKER_PATH
      const releasePath = process.env.POS_ITEST_RELEASE_PATH
      const allocationUuid = process.env.POS_ITEST_ALLOCATION_UUID
      const companyUuid = process.env.POS_ITEST_COMPANY_UUID
      const deviceUuid = process.env.POS_ITEST_DEVICE_UUID
      if (!markerPath || !releasePath || !allocationUuid || !companyUuid || !deviceUuid) {
        throw new Error('hold-recovery-intent requires marker, release and owner identity')
      }

      const recoveries = realRepositories(database).allocationRecoveries
      database.exec('BEGIN IMMEDIATE')
      const recovery = recoveries.beginIntent({
        allocationUuid,
        companyUuid,
        deviceUuid,
        nowIso: new Date().toISOString()
      })
      writeFileSync(markerPath, JSON.stringify({ holding: true, state: recovery.state }))
      waitForFileSync(releasePath, 15_000)
      database.exec('COMMIT')
      emit({ outcome: 'intent-committed' })
      break
    }

    /**
     * The negative control for the busy probe (BH-04B-3-R1 §2 sensitivity check): runs the exact
     * same `busy_timeout = 0` probe as `probe-and-checkout`, with no holder anywhere, and reports
     * what it observed. Used to prove the probe is discriminating — that it reports `busy: false`
     * when nothing actually contends — rather than assuming the mechanism is meaningful.
     */
    case 'probe-only': {
      database.pragma('busy_timeout = 0')
      let busy = false
      try {
        database.exec('BEGIN IMMEDIATE')
        database.exec('ROLLBACK')
      } catch (error) {
        busy = isBusyError(error)
        if (!busy) {
          throw error
        }
      }
      database.pragma('busy_timeout = 5000')
      emit({ outcome: 'probed', busy })
      break
    }

    /**
     * The real checkout side. Rebuilds the authorized context via the exact same production
     * fixture every other checkout suite in this repo uses (`setUpAuthorizedContext`,
     * `LocalSaleService`), then commits one real sale of the tracked product against the
     * allocation the parent seeded before starting any worker.
     *
     * The busy probe runs on the SAME connection `LocalSaleService` goes on to use, before any
     * write this process makes — including `setUpAuthorizedContext`'s own setup writes (license,
     * session, shift). SQLite allows only one write transaction per database file at a time, so
     * once this probe observes the lock held, every subsequent write on this same connection —
     * setup and the real sale alike — is *necessarily* still blocked behind the same lock; the
     * production `runSerializedWrite` callback inside `LocalSaleService.complete()` cannot have
     * started running until the holder released.
     */
    case 'probe-and-checkout': {
      const readyPath = process.env.POS_ITEST_READY_PATH
      const probeResultPath = process.env.POS_ITEST_PROBE_RESULT_PATH
      const attemptKey = process.env.POS_ITEST_ATTEMPT_KEY
      if (!readyPath || !probeResultPath || !attemptKey) {
        throw new Error(
          'probe-and-checkout requires POS_ITEST_READY_PATH, POS_ITEST_PROBE_RESULT_PATH, POS_ITEST_ATTEMPT_KEY'
        )
      }

      writeFileSync(readyPath, JSON.stringify({ ready: true, at: Date.now() }))

      database.pragma('busy_timeout = 0')
      let busy = false
      try {
        database.exec('BEGIN IMMEDIATE')
        // Unexpected: nothing held the lock. Roll back immediately rather than proceeding with an
        // open transaction under a 0ms busy_timeout.
        database.exec('ROLLBACK')
      } catch (error) {
        busy = isBusyError(error)
        if (!busy) {
          throw error
        }
      }
      // Restore the production value before any further write — including setup — is attempted.
      database.pragma('busy_timeout = 5000')
      writeFileSync(probeResultPath, JSON.stringify({ busy, probedAt: Date.now() }))

      const repositories = realRepositories(database)
      const fixture = setUpAuthorizedContext(database, repositories)
      const outcome = fixture.localSale.complete(
        attemptKey,
        validIntent({
          items: [
            {
              id: 'tracked-line',
              productUuid: trackedProductUuid,
              quantity: '1.000',
              discountType: null,
              discountValue: 0
            }
          ],
          payments: [
            {
              id: 'payment-1',
              paymentMethodUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              amount: 500,
              reference: null
            }
          ]
        })
      )

      if (outcome.outcome === 'committed' || outcome.outcome === 'acknowledged') {
        emit({
          outcome: outcome.outcome,
          busy,
          attemptKey: outcome.attemptKey,
          invoiceLocalUuid: outcome.invoice.localUuid,
          itemCount: outcome.items.length
        })
      } else {
        emit({ outcome: outcome.outcome, busy, detail: outcome })
      }
      break
    }

    /**
     * Applies a coverage boundary via the real `AllocationReconciliationService`, in its own
     * process and connection. Used both for BH-04B-3-R1's sequential ordering test (§2, "keep as
     * useful cross-process ordering/recovery coverage; describe it as sequential") and for the
     * post-checkout composition step, where the parent supplies the *actual* values read back from
     * the real committed consumption row rather than a value the test precomputed.
     */
    case 'apply-coverage': {
      const allocationUuid = process.env.POS_ITEST_ALLOCATION_UUID
      const companyUuid = process.env.POS_ITEST_COMPANY_UUID
      const deviceUuid = process.env.POS_ITEST_DEVICE_UUID
      const sequence = Number(process.env.POS_ITEST_SEQUENCE ?? '1')
      const rightsGeneration = Number(process.env.POS_ITEST_RIGHTS_GENERATION ?? '1')
      const quantityMilli = Number(process.env.POS_ITEST_QUANTITY_MILLI ?? '0')
      const chainHash = process.env.POS_ITEST_CHAIN_HASH
      if (!allocationUuid || !companyUuid || !deviceUuid || !chainHash) {
        throw new Error(
          'apply-coverage requires POS_ITEST_ALLOCATION_UUID, POS_ITEST_COMPANY_UUID, POS_ITEST_DEVICE_UUID, POS_ITEST_CHAIN_HASH'
        )
      }

      const repositories = realRepositories(database)
      const result = runSerializedWrite(database, () =>
        repositories.allocationReconciliation.applyCoverage(
          {
            allocationUuid,
            rightsGeneration,
            acceptedConsumptionSequence: sequence,
            acceptedConsumedQuantityMilli: quantityMilli,
            acceptedChainHash: chainHash
          },
          { companyUuid, deviceUuid },
          'invoice_upload',
          new Date().toISOString()
        )
      )

      emit({
        outcome: result.kind,
        reason: 'reason' in result ? result.reason : null
      })
      break
    }

    /** Legacy helper retained for the sequential test's real-row seeding step (no hold/sleep). */
    case 'commit-consumption': {
      const allocationUuid = process.env.POS_ITEST_ALLOCATION_UUID
      const invoiceUuid = process.env.POS_ITEST_INVOICE_UUID
      const itemUuid = process.env.POS_ITEST_ITEM_UUID
      const localUuid = process.env.POS_ITEST_LOCAL_UUID
      const requestHash = process.env.POS_ITEST_REQUEST_HASH
      const companyUuid = process.env.POS_ITEST_COMPANY_UUID
      const deviceUuid = process.env.POS_ITEST_DEVICE_UUID
      const warehouseUuid = process.env.POS_ITEST_WAREHOUSE_UUID
      const productUuid = process.env.POS_ITEST_PRODUCT_UUID
      if (
        !allocationUuid ||
        !invoiceUuid ||
        !itemUuid ||
        !localUuid ||
        !requestHash ||
        !companyUuid ||
        !deviceUuid ||
        !warehouseUuid ||
        !productUuid
      ) {
        throw new Error('commit-consumption requires the full set of identity env vars')
      }

      runSerializedWrite(database, () => {
        const attemptKey = `9a${invoiceUuid.slice(2)}`
        database
          .prepare(
            `INSERT INTO sale_attempts (
               attempt_key, company_uuid, device_uuid, user_uuid, claim_session_epoch,
               origin_shift_uuid, origin_shift_observed_at, origin_branch_uuid, origin_warehouse_uuid,
               origin_context_fingerprint, intent_fingerprint, intent_version, intent_json, state,
               claimed_at, last_attempted_at, updated_at
             ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, '{"v":1}', 'claimed', ?, ?, ?)`
          )
          .run(
            attemptKey,
            companyUuid,
            deviceUuid,
            companyUuid,
            companyUuid,
            '2026-09-06T00:00:00.000Z',
            companyUuid,
            warehouseUuid,
            'a'.repeat(64),
            'a'.repeat(64),
            '2026-09-06T00:00:00.000Z',
            '2026-09-06T00:00:00.000Z',
            '2026-09-06T00:00:00.000Z'
          )
        database
          .prepare(
            `INSERT INTO local_invoices (
               local_uuid, attempt_key, offline_number, sync_status, sync_attempts, company_uuid,
               branch_uuid, warehouse_uuid, device_uuid, user_uuid, shift_uuid, commit_session_epoch,
               catalog_revision, intent_fingerprint, currency, currency_exponent, tax_mode,
               invoice_discount_value, subtotal_amount, discount_total_amount, tax_total_amount,
               grand_total_amount, paid_total_amount, change_due_amount, due_amount, sold_at,
               connectivity_state_at_sale, sold_while_offline, commercial_snapshot_json,
               upload_payload_version, created_at, updated_at
             ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'USD', 2, 'none', 0, 1000, 0,
                       0, 1000, 1000, 0, 0, ?, 'online', 0, '{}', 2, ?, ?)`
          )
          .run(
            invoiceUuid,
            attemptKey,
            `POS-CONC-${invoiceUuid.slice(-6)}`,
            companyUuid,
            companyUuid,
            warehouseUuid,
            deviceUuid,
            companyUuid,
            companyUuid,
            'a'.repeat(64),
            'a'.repeat(64),
            '2026-09-06T00:00:00.000Z',
            '2026-09-06T00:00:00.000Z',
            '2026-09-06T00:00:00.000Z'
          )
        database
          .prepare(
            `UPDATE sale_attempts SET state = 'committed', invoice_local_uuid = ?, committed_at = ?,
                    last_attempted_at = ?, updated_at = ? WHERE attempt_key = ?`
          )
          .run(
            invoiceUuid,
            '2026-09-06T00:00:00.000Z',
            '2026-09-06T00:00:00.000Z',
            '2026-09-06T00:00:00.000Z',
            attemptKey
          )
        database
          .prepare(
            `INSERT INTO local_invoice_items (
               local_uuid, invoice_local_uuid, line_index, product_uuid, product_name, track_stock,
               quantity_milli, unit_price_amount, currency, price_revision, tax_mode,
               tax_rate_basis_points, tax_revision, discount_value, subtotal_amount, discount_amount,
               tax_amount, total_amount, allocation_covered_milli, uncovered_milli, created_at
             ) VALUES (?, ?, 0, ?, 'Widget', 1, 3000, 1000, 'USD', ?, 'none', 0, ?, 0, 1000, 0, 0, 1000, 3000, 0, ?)`
          )
          .run(
            itemUuid,
            invoiceUuid,
            productUuid,
            'a'.repeat(64),
            'a'.repeat(64),
            '2026-09-06T00:00:00.000Z'
          )

        const chainHash = allocationJournalAppend(allocationJournalInitialHash(allocationUuid, 1), {
          allocationUuid,
          rightsGeneration: 1,
          consumptionSequence: 1,
          localConsumptionUuid: localUuid,
          invoiceIdempotencyKey: invoiceUuid,
          itemLineUuid: itemUuid,
          quantityMilli: 3_000,
          requestHash
        })
        database
          .prepare(
            `INSERT INTO local_stock_allocation_consumptions (
               local_uuid, allocation_uuid, consumption_sequence, invoice_local_uuid, item_local_uuid,
               quantity_milli, server_status, created_at, rights_generation, invoice_idempotency_key,
               item_line_uuid, request_hash, entry_hash, chain_hash
             ) VALUES (?, ?, 1, ?, ?, 3000, 'pending', ?, 1, ?, ?, ?, ?, ?)`
          )
          .run(
            localUuid,
            allocationUuid,
            invoiceUuid,
            itemUuid,
            '2026-09-06T00:00:00.000Z',
            invoiceUuid,
            itemUuid,
            requestHash,
            chainHash.entryHash,
            chainHash.chainHash
          )
      })

      emit({ outcome: 'committed' })
      break
    }

    default:
      throw new Error(`Unknown allocationConcurrencyWorker command: ${command}`)
  }

  database.close()
} catch (error) {
  database.close()
  emit({ outcome: 'worker-error', message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
}

function isBusyError(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code
  return (
    typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
  )
}
