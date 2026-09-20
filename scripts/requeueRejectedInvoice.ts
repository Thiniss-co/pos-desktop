import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { SyncQueueRepository } from '../src/main/repositories/syncQueue.repository'
import { payloadHash } from '../src/main/services/localSale.fingerprint'

/**
 * PS8 — re-offer ONE terminally-rejected invoice upload after the server-side defect that refused
 * it has been fixed.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a single-invoice, operator-initiated, inspect-then-confirm command. It moves exactly one
 * `sync_queue` row from `rejected` back to `pending` and lets the application's ordinary
 * authenticated upload worker do the rest: the same endpoint, the same credentials, the same
 * idempotency key, the same acknowledgment handling.
 *
 * It is **not** a retry policy. It takes no error-code predicate, has no "all rejected rows" form,
 * mints no new invoice or idempotency key, edits no frozen payload, and never marks anything
 * synced. `rejected -> pending` remains absent from `SYNC_QUEUE_TRANSITIONS`, so nothing automatic
 * can perform this move — only this command, naming one invoice.
 *
 * ## The four identities it insists on
 *
 * The operator must supply the local invoice uuid, the idempotency key and the payload hash, and
 * the row must currently be `rejected`. The payload's own bytes are re-hashed here and compared to
 * the stored hash as well, so a payload mutated since it was frozen is refused rather than
 * re-offered. Any mismatch prints what was found and writes nothing.
 *
 * ## Usage
 *
 *   node scripts/runElectronNode.mjs scripts/requeueRejectedInvoice.ts \
 *     --database=<path to pos-desktop.sqlite> \
 *     --invoice=<local_invoice_uuid> \
 *     --idempotency-key=<idempotency_key> \
 *     --payload-hash=<payload_hash> \
 *     [--confirm]
 *
 * Without `--confirm` it only inspects and prints. The application must be CLOSED before running it
 * with `--confirm`: two writers on one SQLite file is not a supported state, and the worker must
 * observe the requeued row on a clean start.
 */

interface Arguments {
  readonly database: string
  readonly invoice: string
  readonly idempotencyKey: string
  readonly payloadHash: string
  readonly confirm: boolean
}

interface QueueRow {
  readonly local_queue_uuid: string
  readonly state: string
  readonly idempotency_key: string
  readonly payload_hash: string
  readonly payload_json: string
  readonly attempt_count: number
  readonly last_error_code: string | null
  readonly last_error_details: string | null
  readonly updated_at: string
}

function readArguments(): Arguments {
  const raw = new Map<string, string>()

  for (const argument of process.argv.slice(2)) {
    const [key, ...rest] = argument.replace(/^--/, '').split('=')
    raw.set(key, rest.join('='))
  }

  const required = (name: string): string => {
    const value = raw.get(name)

    if (!value) {
      console.error(`[requeue] missing required argument --${name}`)
      console.error(
        '[requeue] usage: --database=<pos-desktop.sqlite> --invoice=<local_invoice_uuid> --idempotency-key=<key> --payload-hash=<hash> [--confirm]'
      )
      process.exit(2)
    }

    return value
  }

  return {
    database: required('database'),
    invoice: required('invoice'),
    idempotencyKey: required('idempotency-key'),
    payloadHash: required('payload-hash'),
    confirm: raw.has('confirm')
  }
}

function fail(message: string): never {
  console.error(`[requeue] REFUSED: ${message}`)
  process.exit(1)
}

const args = readArguments()

if (!existsSync(args.database)) {
  fail(`no database at ${args.database}`)
}

const database = new Database(args.database)

try {
  database.pragma('foreign_keys = ON')

  const row = database
    .prepare(
      `SELECT local_queue_uuid, state, idempotency_key, payload_hash, payload_json, attempt_count,
              last_error_code, last_error_details, updated_at
         FROM sync_queue
        WHERE aggregate_type = 'invoice' AND operation = 'upload' AND local_aggregate_uuid = ?`
    )
    .get(args.invoice) as QueueRow | undefined

  if (!row) {
    fail(`no invoice upload queued for local invoice ${args.invoice}`)
  }

  console.log('[requeue] found the queued upload:')
  console.log(`  queue row      : ${row.local_queue_uuid}`)
  console.log(`  state          : ${row.state}`)
  console.log(`  attempts       : ${row.attempt_count}`)
  console.log(`  last error     : ${row.last_error_code ?? '(none)'}`)
  console.log(`  last details   : ${row.last_error_details ?? '(none)'}`)
  console.log(`  idempotency key: ${row.idempotency_key}`)
  console.log(`  payload hash   : ${row.payload_hash}`)

  if (row.state !== 'rejected') {
    fail(
      `the queue row is '${row.state}', not 'rejected'. Only a terminal rejection is re-offered.`
    )
  }

  if (row.idempotency_key !== args.idempotencyKey) {
    fail('the stored idempotency key is not the one named on the command line')
  }

  if (row.payload_hash !== args.payloadHash) {
    fail('the stored payload hash is not the one named on the command line')
  }

  // The frozen bytes must still hash to what was recorded when they were frozen. This is the check
  // that makes "the payload was never edited" a verified fact rather than an assumption.
  const recomputed = payloadHash(JSON.parse(row.payload_json))

  if (recomputed !== row.payload_hash) {
    fail(
      `the frozen payload no longer hashes to its recorded value (recomputed ${recomputed}). It must not be re-offered.`
    )
  }

  console.log('[requeue] the frozen payload re-hashes to its recorded value: bytes are intact.')

  if (!args.confirm) {
    console.log('[requeue] inspection only. Re-run with --confirm to re-offer this upload.')
    process.exit(0)
  }

  const requeued = new SyncQueueRepository(database).requeueRejectedUpload(args.invoice, {
    idempotencyKey: args.idempotencyKey,
    payloadHash: args.payloadHash
  })

  if (!requeued) {
    fail('the row changed between inspection and the write; nothing was re-offered')
  }

  console.log(
    `[requeue] ${args.invoice} is pending again under its ORIGINAL idempotency key. Start the app; the ordinary upload worker will send it.`
  )
} finally {
  database.close()
}
