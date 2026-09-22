import { openSandboxDatabaseAtPath } from './openTestDatabase'
import { realRepositories } from './realRepositories'

/**
 * r6 scenario 7 — the other side of `startFreshProcess()` for the refund restart proof.
 *
 * A genuinely separate Electron-node process that reopens the SAME sandbox database file the
 * parent process wrote to, runs the real production startup sweep
 * (`LocalRefundRepository.sweepDispatchedToUnresolved`), and reports back the swept row's state
 * and integrity digest. It holds no state from the parent — everything here is read back from
 * disk, exactly what a real application restart would do.
 */

const RESULT_PREFIX = '@@RESULT@@'

function emit(value: Record<string, unknown>): void {
  console.log(RESULT_PREFIX + JSON.stringify(value))
}

const databasePath = process.env.POS_ITEST_DB_PATH

if (!databasePath) {
  throw new Error('refundRecoveryWorker requires POS_ITEST_DB_PATH')
}

const database = openSandboxDatabaseAtPath(databasePath)
const repositories = realRepositories(database)

try {
  const before = database
    .prepare(
      "SELECT local_uuid, request_sha256 FROM local_refunds WHERE submission_state = 'dispatched'"
    )
    .all() as { local_uuid: string; request_sha256: string }[]

  const swept = repositories.localRefunds.sweepDispatchedToUnresolved(
    // The owner is discovered from the one dispatched row, not passed in -- this process shares
    // no in-memory state with the parent.
    before.length > 0
      ? (() => {
          const row = database
            .prepare('SELECT company_uuid, device_uuid FROM local_refunds WHERE local_uuid = ?')
            .get(before[0].local_uuid) as { company_uuid: string; device_uuid: string }
          return { companyUuid: row.company_uuid, deviceUuid: row.device_uuid }
        })()
      : { companyUuid: '', deviceUuid: '' },
    new Date().toISOString()
  )

  const target = before[0]
  const after = target ? repositories.localRefunds.findByLocalUuid(target.local_uuid) : null

  emit({
    swept,
    state: after?.submissionState ?? null,
    requestSha256: after?.requestSha256 ?? null
  })

  database.close()
} catch (error) {
  database.close()
  emit({ outcome: 'worker-error', message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
}
