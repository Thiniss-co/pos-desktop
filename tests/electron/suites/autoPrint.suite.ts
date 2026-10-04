import { deepEqual, equal, ok, throws } from 'node:assert/strict'
import { DEFAULT_PRINTER_SETTINGS } from '../../../src/shared/contracts/printing.contract'
import { closeDatabase, type SqliteDatabase } from '../../../src/main/database/connection'
import {
  AutoPrintAdmissionService,
  AutoPrintIntentService
} from '../../../src/main/receipt/autoPrint.service'
import type { PreparedAutoJob } from '../../../src/main/receipt/receiptPrinting.service'
import type { ReceiptOwner } from '../../../src/main/receipt/receiptAccess.service'
import { databaseTest, type DatabaseSandbox } from '../support/sandbox'
import { readCommitted } from '../support/committedState'
import { openExistingTestDatabase, openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'
import {
  companyUuid,
  deviceUuid,
  setUpAuthorizedContext,
  userUuid,
  validIntent
} from '../support/localSaleFixture'

/**
 * POS improvements, Stage 7 — automatic printing on the real 0025 schema: the intent is frozen in the
 * sale-commit transaction and never changes; each intent gets exactly one admission; an admitted row
 * and its AUTO job exist together or not at all; an intent left pending survives a restart.
 */

const PRINTER = { ...DEFAULT_PRINTER_SETTINGS, printerName: 'PW-Virtual-80' }
const HASH = 'a'.repeat(64)

function owner(database: SqliteDatabase): ReceiptOwner {
  return {
    companyUuid,
    deviceUuid,
    userUuid,
    sessionEpoch: realRepositories(database).sessionEpoch.current()
  }
}

/** A sale committed through the real local-sale transaction, with the real intent service wired. */
function commitSale(
  database: SqliteDatabase,
  attemptKey: string,
  options: { newSession?: boolean } = {}
): string {
  const repositories = realRepositories(database)
  const autoPrintIntent = new AutoPrintIntentService({
    repository: realRepositories(database).autoPrint,
    preferences: {
      autoPrintFor: (who) => repositories.userPreferences.get(who, 'printing.autoPrint') ?? true
    },
    printerSettings: { get: () => PRINTER },
    locale: () => 'en'
  })
  const { localSale } = setUpAuthorizedContext(
    database,
    repositories,
    undefined,
    'online',
    options.newSession ?? true,
    { autoPrintIntent }
  )
  const outcome = localSale.complete(attemptKey, validIntent())
  ok(outcome.outcome === 'committed', JSON.stringify(outcome))
  return outcome.outcome === 'committed' ? outcome.invoice.localUuid : ''
}

/** Admission over the real tables; the job comes from the real print-job repository. */
function admission(
  database: SqliteDatabase,
  options: { soldAt: string; afterJobInsert?: () => void; installed?: string[] }
): { service: AutoPrintAdmissionService; started: string[] } {
  const jobs = realRepositories(database).receiptPrintJobs
  const started: string[] = []
  const service = new AutoPrintAdmissionService({
    repository: realRepositories(database).autoPrint,
    access: { resolveCaller: () => owner(database), assertSaleDocument: (_o, row) => row! },
    printing: {
      listPrinters: async () =>
        (options.installed ?? ['PW-Virtual-80']).map((name) => ({ name, displayName: name })),
      prepareAutoJob: (who, input) =>
        ({
          document: { kind: 'sale', invoiceLocalUuid: input.invoiceLocalUuid },
          options: {} as PreparedAutoJob['options'],
          job: {
            jobUuid: crypto.randomUUID(),
            requestId: `auto-sale:${input.invoiceLocalUuid}`,
            clientIntentJson: '{}',
            clientIntentSha256: HASH,
            trigger: 'auto',
            ownerCompanyUuid: who.companyUuid,
            ownerDeviceUuid: who.deviceUuid,
            requestedByUserUuid: who.userUuid,
            sessionEpochAtClaim: who.sessionEpoch,
            documentKind: 'sale',
            documentLocalUuid: input.invoiceLocalUuid,
            documentJson: '{}',
            documentSha256: HASH,
            templateVersion: 2,
            locale: input.locale,
            isReprint: false,
            factsProjection: '{}',
            transactionFactsSha256: HASH,
            resolvedOptionsJson: '{}',
            optionsSha256: HASH,
            createdAt: options.soldAt
          }
        }) satisfies PreparedAutoJob,
      claimAutoJob: (prepared) => jobs.claim(prepared.job),
      runAdmittedAutoJob: async (job) => {
        started.push(job.jobUuid)
        return {} as never
      }
    },
    printerSettings: { get: () => PRINTER },
    preferences: { current: () => ({ touchMode: false, autoPrint: true }) },
    localSale: realRepositories(database).localSale,
    jobs,
    now: () => new Date(Date.parse(options.soldAt) + 60_000),
    afterJobInsert: options.afterJobInsert
  })
  return { service, started }
}

function soldAt(sandbox: DatabaseSandbox, invoice: string): string {
  const [row] = readCommitted(sandbox, 'SELECT sold_at FROM local_invoices WHERE local_uuid = ?', [
    invoice
  ]) as Array<{ sold_at: string }>
  return row!.sold_at
}

databaseTest(
  'the intent is written in the sale commit, is immutable, and is absent when the user turned it off',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const invoice = commitSale(database, 'f7000000-0000-4000-8000-000000000001')
      const [intent] = readCommitted(sandbox, 'SELECT * FROM auto_print_intents') as Array<
        Record<string, unknown>
      >
      equal(intent?.invoice_local_uuid, invoice)
      equal(intent?.committed_at, soldAt(sandbox, invoice))
      equal(intent?.setup_state_at_commit, 'configured')
      equal(JSON.parse(String(intent?.printer_snapshot_json)).printerName, 'PW-Virtual-80')
      throws(() => database.prepare("UPDATE auto_print_intents SET locale = 'ar'").run())
      throws(() => database.prepare('DELETE FROM auto_print_intents').run())

      // A snapshot that says "no printer" must be recorded as no_printer (CHECK).
      throws(() =>
        database
          .prepare(
            `INSERT INTO auto_print_intents VALUES (?, ?, ?, ?, ?, 'en', '{"printerName":null}', ?, 'configured')`
          )
          .run(invoice, companyUuid, deviceUuid, userUuid, '2026-01-01T00:00:00Z', HASH)
      )

      realRepositories(database).userPreferences.set(
        { companyUuid, userUuid },
        'printing.autoPrint',
        false,
        '2026-01-01T00:00:00Z'
      )
      commitSale(database, 'f7000000-0000-4000-8000-000000000002', { newSession: false })
      equal(readCommitted(sandbox, 'SELECT * FROM local_invoices').length, 2)
      equal(readCommitted(sandbox, 'SELECT * FROM auto_print_intents').length, 1)
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'an admission is insert-once and an admitted row can only link the AUTO job of its own sale',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const invoice = commitSale(database, 'f7000000-0000-4000-8000-000000000003')
      const insert = (job: string | null, outcome: string, epoch: number | null): unknown =>
        database
          .prepare(
            `INSERT INTO auto_print_admissions (invoice_local_uuid, job_uuid, outcome, admitted_session_epoch, decided_at)
             VALUES (?, ?, ?, ?, '2026-01-01T00:00:00Z')`
          )
          .run(invoice, job, outcome, epoch)
      throws(() => insert(null, 'admitted', 1)) // admitted needs its job
      throws(() => insert('00000000-0000-4000-8000-00000000dead', 'admitted', 1)) // not this sale's AUTO job
      throws(() => insert(null, 'printer_missing', 1)) // epoch only with an admitted job

      const { service, started } = admission(database, { soldAt: soldAt(sandbox, invoice) })
      const decisions = await service.admitPending('commit')
      equal(decisions[0]?.outcome, 'admitted')
      deepEqual(started, [decisions[0]?.jobUuid])
      throws(() => insert(null, 'printer_missing', null)) // a second decision for the same intent
      throws(() =>
        database.prepare("UPDATE auto_print_admissions SET outcome = 'expired_unprinted'").run()
      )
      throws(() => database.prepare('DELETE FROM auto_print_admissions').run())
      deepEqual(await service.admitPending('session'), [])
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'a fault between the job insert and the admission insert leaves neither; the next run admits exactly once',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    try {
      const invoice = commitSale(database, 'f7000000-0000-4000-8000-000000000004')
      let fail = true
      const { service, started } = admission(database, {
        soldAt: soldAt(sandbox, invoice),
        afterJobInsert: () => {
          if (fail) throw new Error('injected fault after the job insert')
        }
      })

      deepEqual(await service.admitPending('commit'), [])
      equal(readCommitted(sandbox, 'SELECT * FROM receipt_print_jobs').length, 0)
      equal(readCommitted(sandbox, 'SELECT * FROM auto_print_admissions').length, 0)

      fail = false
      equal((await service.admitPending('session'))[0]?.outcome, 'admitted')
      await service.admitPending('session')
      equal(
        readCommitted(sandbox, "SELECT * FROM receipt_print_jobs WHERE trigger = 'auto'").length,
        1
      )
      equal(readCommitted(sandbox, 'SELECT * FROM auto_print_admissions').length, 1)
      equal(started.length, 1)
    } finally {
      closeDatabase(database)
    }
  }
)

databaseTest(
  'two connections deciding the same intent: the one holding the write lock wins, the other writes nothing',
  async (sandbox) => {
    const first = openTestDatabase(sandbox)
    const second = openExistingTestDatabase(sandbox)
    second.pragma('busy_timeout = 0')
    try {
      const invoice = commitSale(first, 'f7000000-0000-4000-8000-000000000005')
      const sold = soldAt(sandbox, invoice)
      const other = admission(second, { soldAt: sold })
      let interleaved: unknown = null
      const winner = admission(first, {
        soldAt: sold,
        // While the first connection holds BEGIN IMMEDIATE (its job already inserted), the second
        // connection runs its whole decision.
        afterJobInsert: () => {
          interleaved = other.service.admitPending('commit')
        }
      })

      const decisions = await winner.service.admitPending('commit')
      deepEqual(await (interleaved as Promise<unknown>), [])
      equal(decisions[0]?.outcome, 'admitted')
      deepEqual(await other.service.admitPending('session'), [])
      equal(readCommitted(sandbox, 'SELECT * FROM receipt_print_jobs').length, 1)
      equal(readCommitted(sandbox, 'SELECT * FROM auto_print_admissions').length, 1)
      equal(winner.started.length + other.started.length, 1)
    } finally {
      closeDatabase(second)
      closeDatabase(first)
    }
  }
)

databaseTest(
  'an intent left pending by a stopped app survives the restart and is admitted once after relaunch',
  async (sandbox) => {
    const before = openTestDatabase(sandbox)
    const invoice = commitSale(before, 'f7000000-0000-4000-8000-000000000006')
    const sold = soldAt(sandbox, invoice)
    closeDatabase(before) // the app stops between commit and admission

    const after = openExistingTestDatabase(sandbox)
    try {
      const { service, started } = admission(after, { soldAt: sold })
      equal((await service.admitPending('startup'))[0]?.outcome, 'admitted')
      deepEqual(await service.admitPending('session'), [])
      equal(started.length, 1)
    } finally {
      closeDatabase(after)
    }
  }
)
