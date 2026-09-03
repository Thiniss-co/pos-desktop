import { closeDatabase } from '../../../src/main/database/connection'
import { DesktopApiClient } from '../../../src/main/http/desktopApiClient'
import type { InvoiceUploadAccepted } from '../../../src/main/sync/invoiceUpload.client'
import { uploadInvoice } from '../../../src/main/sync/invoiceUpload.client'
import { isUploadLeaseExpired } from '../../../src/main/sync/syncPolicy'
import { failingDatabase } from './failingDatabase'
import { liveUploadFixture } from './liveUploadBackend'
import { openSandboxDatabaseAtPath } from './openTestDatabase'
import { realRepositories } from './realRepositories'
import { createUploadTransportSpy } from './uploadTransportSpy'
import {
  bodyDigest,
  buildUploadWorker,
  parkUntilKilled,
  parkUntilKilledSync,
  publishCrashMarker,
  readInvoiceRow,
  readLocalCounts,
  readQueueRow,
  uploadIdentity,
  type CrashStage
} from './uploadCrash'

/**
 * The CP-3G-6 fresh-process upload worker.
 *
 * It is the crash half of every CP-3G-6 proof, and it is deliberately separate from
 * `recoveryWorker.ts`: that worker rebuilds Phase 3F's sale-completion fixture at module load,
 * which has nothing to do with an invoice upload and would run on every command here. What the two
 * share is the contract — a standalone Electron process, holding nothing from its parent,
 * rebuilding everything it acts on from the sandbox database on disk.
 *
 * A `crash` run **parks** at the requested boundary and publishes a coordination file. It never
 * kills itself: the parent verifies the outside world and then delivers a real `SIGKILL` from
 * another process, so nothing here can catch the signal, unwind a stack or run a `finally` block.
 */

const RESULT_PREFIX = '@@RESULT@@'

function emit(value: Record<string, unknown>): void {
  console.log(RESULT_PREFIX + JSON.stringify(value))
}

const databasePath = process.env.POS_ITEST_DB_PATH
const command = process.env.POS_CRASH_COMMAND
const markerDirectory = process.env.POS_CRASH_MARKER_DIR
const stage = process.env.POS_CRASH_STAGE as CrashStage | undefined
const queueUuid = process.env.POS_CRASH_QUEUE_UUID
const invoiceUuid = process.env.POS_CRASH_INVOICE_UUID
const nowOffsetMs = Number(process.env.POS_CRASH_NOW_OFFSET_MS ?? '0')
const companyUuid = process.env.POS_CRASH_COMPANY_UUID
const deviceUuid = process.env.POS_CRASH_DEVICE_UUID

if (!databasePath || !command || !companyUuid || !deviceUuid) {
  throw new Error('uploadCrashWorker requires database, command and owner environment')
}

const database = openSandboxDatabaseAtPath(databasePath)
const owner = { companyUuid, deviceUuid }
const spy = createUploadTransportSpy()

/** The production HTTP client, present only when this run was given a live backend. */
function liveApiClient(): DesktopApiClient {
  const fixture = liveUploadFixture()

  if (fixture === null) {
    throw new Error('uploadCrashWorker needs a live backend for this stage')
  }

  return new DesktopApiClient({
    apiOrigin: new URL(fixture.origin),
    getAccessToken: () => fixture.token,
    getDeviceUuid: () => fixture.deviceUuid,
    fetchImplementation: stagedFetch(fixture.origin),
    timeoutMs: 20_000
  })
}

/**
 * The counting transport, with the two boundaries that live inside one HTTP exchange.
 *
 * `in-flight` publishes before the request is handed to the underlying transport and then parks
 * without ever observing an answer. `response-received` lets the real answer arrive and parks
 * holding it, so the server has certainly answered and the desktop has certainly not recorded it.
 */
function stagedFetch(origin: string): typeof fetch {
  const counting = spy.fetchImplementation

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (stage === 'in-flight') {
      const pending = counting(input as RequestInfo, init)
      // Keep the rejection observed so the park is what ends this process, never an unhandled error.
      void pending.catch(() => undefined)
      publish({ stage: 'in-flight', origin, dispatched: true })
      await parkUntilKilled()
    }

    const response = await counting(input as RequestInfo, init)

    if (stage === 'response-received') {
      publish({ stage: 'response-received', status: response.status, bodyRead: false })
      await parkUntilKilled()
    }

    return response
  }) as typeof fetch
}

/** Publishes the coordination file, always carrying the transport ledger this process observed. */
function publish(extra: Record<string, unknown>): void {
  if (!markerDirectory) {
    throw new Error('uploadCrashWorker requires POS_CRASH_MARKER_DIR')
  }

  const request = spy.uploadRequests().at(-1)
  const queue = queueUuid ? readQueueRow(database, queueUuid) : null

  publishCrashMarker(markerDirectory, {
    pid: process.pid,
    requestCount: spy.count(),
    uploadRequestCount: spy.uploadRequests().length,
    queueState: queue?.state ?? null,
    queueAttemptCount: queue?.attempt_count ?? null,
    queueLeaseAt: queue?.upload_lease_at ?? null,
    requestBodySha256: request ? bodyDigest(request.bodyText) : null,
    requestIdentity: request
      ? uploadIdentity(JSON.parse(request.bodyText) as Record<string, unknown>)
      : null,
    requestPath: request?.pathname ?? null,
    requestMethod: request?.method ?? null,
    ...extra
  })
}

/** The stage-aware dispatch the worker is given in place of a plain upload call. */
function stagedUpload(): (payloadJson: string) => Promise<InvoiceUploadAccepted> {
  if (stage === 'before-dispatch') {
    return async () => {
      // The claim transaction has committed; not one byte has left the process.
      publish({ stage: 'before-dispatch', dispatched: false })
      return parkUntilKilled()
    }
  }

  const apiClient = liveApiClient()

  return async (payloadJson: string) => {
    const accepted = await uploadInvoice(apiClient, payloadJson)

    if (stage === 'before-outcome') {
      // The answer is parsed and accepted. Nothing has been written to SQLite.
      publish({
        stage: 'before-outcome',
        acceptedKind: accepted.kind,
        remoteUuidPresent: typeof accepted.invoice.id === 'string'
      })
      await parkUntilKilled()
    }

    return accepted
  }
}

/**
 * Parks inside the final outcome transaction, immediately after the queue row has been written to
 * `synced` and before the transaction commits. Killing here proves the write is atomic: a reopened
 * database must show the pre-transaction state, never a half-applied success.
 */
function outcomeDatabase(): ReturnType<typeof failingDatabase> {
  return failingDatabase(database, {
    // Never used: a crash is a signal, not an exception. Only the boundary hook fires.
    failOnWriteNumber: -1,
    afterWrite: (statementSql) => {
      if (statementSql.includes("state = 'synced'")) {
        publish({ stage: 'during-outcome', queueRowWrittenInsideOpenTransaction: true })
        parkUntilKilledSync()
      }
    }
  })
}

async function runCrash(): Promise<void> {
  const wrapped = stage === 'during-outcome' ? outcomeDatabase() : database
  const repositories = realRepositories(wrapped)
  const worker = buildUploadWorker({
    database: wrapped,
    repositories,
    owner,
    upload: stagedUpload(),
    nowOffsetMs
  })

  await worker.run()
  emit({ outcome: 'survived-the-crash-boundary', stage })
  process.exitCode = 1
}

async function runDrain(): Promise<void> {
  const repositories = realRepositories(database)
  const worker = buildUploadWorker({
    database,
    repositories,
    owner,
    upload: (payloadJson) => uploadInvoice(liveApiClient(), payloadJson),
    nowOffsetMs,
    hasPermission: process.env.POS_CRASH_PERMISSION !== '0'
  })
  const summary = await worker.run()
  const request = spy.uploadRequests().at(-1)

  emit({
    outcome: 'drained',
    summary,
    requestCount: spy.count(),
    uploadRequestCount: spy.uploadRequests().length,
    requestPaths: spy.requests.map((entry) => entry.pathname),
    requestBodySha256: request ? bodyDigest(request.bodyText) : null,
    requestIdentity: request
      ? uploadIdentity(JSON.parse(request.bodyText) as Record<string, unknown>)
      : null,
    ...inspect()
  })
}

/** The production reclaim, run alone so the intermediate state it writes is observable. */
function runReclaimOnly(): void {
  const repositories = realRepositories(database)
  const nowIso = new Date(Date.now() + nowOffsetMs).toISOString()
  const reclaimed = repositories.syncQueue.reclaimExpiredUploadLeases(
    owner,
    nowIso,
    (leaseAt, now) => isUploadLeaseExpired(leaseAt, now, 60_000)
  )

  emit({ outcome: 'reclaimed', reclaimed, nowIso, requestCount: spy.count(), ...inspect() })
}

function inspect(): Record<string, unknown> {
  return {
    queue: queueUuid ? readQueueRow(database, queueUuid) : null,
    invoice: invoiceUuid ? (readInvoiceRow(database, invoiceUuid) ?? null) : null,
    localCounts: readLocalCounts(database)
  }
}

async function main(): Promise<void> {
  switch (command) {
    case 'crash':
      await runCrash()
      break
    case 'drain':
      await runDrain()
      break
    case 'reclaim-only':
      runReclaimOnly()
      break
    case 'inspect':
      emit({ outcome: 'inspected', requestCount: spy.count(), ...inspect() })
      break
    default:
      throw new Error(`Unknown uploadCrashWorker command: ${command}`)
  }
}

main()
  .then(() => {
    closeDatabase(database)
  })
  .catch((error: unknown) => {
    closeDatabase(database)
    emit({
      outcome: 'worker-error',
      message: error instanceof Error ? error.message : String(error)
    })
    process.exitCode = 1
  })
