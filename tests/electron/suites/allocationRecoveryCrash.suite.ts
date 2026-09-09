import { deepEqual, equal, ok } from 'node:assert/strict'
import { resolve } from 'node:path'
import { closeDatabase } from '../../../src/main/database/connection'
import { grant } from '../support/allocationScenario'
import { startFreshProcess, type FreshProcessOutcome } from '../support/freshProcess'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'
import { databaseTest, type DatabaseSandbox } from '../support/sandbox'
import { crashMarkerPath } from '../support/uploadCrash'

const ALLOCATION_UUID = '00000000-0000-4000-8000-000000000451'
const workerSource = resolve(
  process.cwd(),
  'tests/electron/support/allocationRecoveryCrashWorker.ts'
)

type CrashStage =
  | 'after-intent-before-seal-response'
  | 'during-seal-outcome'
  | 'after-seal-outcome-before-ack-response'
  | 'ack-response-received-before-outcome'
  | 'during-ack-outcome'

interface RecoverySummary {
  readonly state: string
  readonly requestSealIdempotencyKey: string
  readonly acknowledgeIdempotencyKey: string | null
  readonly terminalSequence: number | null
  readonly terminalConsumedQuantityMilli: number | null
  readonly terminalHash: string | null
}

function result(outcome: FreshProcessOutcome): Record<string, unknown> {
  equal(outcome.status, 0, outcome.stderr)
  ok(outcome.result !== null, outcome.stdout)
  return outcome.result
}

async function runWorker(
  sandbox: DatabaseSandbox,
  command: 'inspect' | 'resume'
): Promise<Record<string, unknown>> {
  const processHandle = startFreshProcess(sandbox, workerSource, `allocation-${command}`, {
    POS_RECOVERY_COMMAND: command
  })
  return result(await processHandle.wait())
}

function recoveryOf(value: Record<string, unknown>): RecoverySummary {
  ok(value.recovery && typeof value.recovery === 'object')
  return value.recovery as RecoverySummary
}

const scenarios: readonly {
  readonly stage: CrashStage
  readonly rolledBackState: 'intent' | 'sealed'
  readonly requestKind: 'seal' | 'acknowledgement'
  readonly markerRecoveryState: 'intent' | 'sealed'
  readonly markerGrantStatus: 'active' | 'revocation_pending' | 'seal_acknowledged'
}[] = [
  {
    stage: 'after-intent-before-seal-response',
    rolledBackState: 'intent',
    requestKind: 'seal',
    markerRecoveryState: 'intent',
    markerGrantStatus: 'active'
  },
  {
    stage: 'during-seal-outcome',
    rolledBackState: 'intent',
    requestKind: 'seal',
    markerRecoveryState: 'sealed',
    markerGrantStatus: 'revocation_pending'
  },
  {
    stage: 'after-seal-outcome-before-ack-response',
    rolledBackState: 'sealed',
    requestKind: 'acknowledgement',
    markerRecoveryState: 'sealed',
    markerGrantStatus: 'revocation_pending'
  },
  {
    stage: 'ack-response-received-before-outcome',
    rolledBackState: 'sealed',
    requestKind: 'acknowledgement',
    markerRecoveryState: 'sealed',
    markerGrantStatus: 'revocation_pending'
  },
  {
    stage: 'during-ack-outcome',
    rolledBackState: 'sealed',
    requestKind: 'acknowledgement',
    markerRecoveryState: 'sealed',
    markerGrantStatus: 'seal_acknowledged'
  }
]

for (const scenario of scenarios) {
  databaseTest(
    `BH-04B-4 SIGKILL recovery at ${scenario.stage} resumes one frozen identity without reviving rights`,
    async (sandbox) => {
      const database = openTestDatabase(sandbox)
      const repositories = realRepositories(database)
      repositories.stockAllocations.ingestBootstrapSnapshot(
        1,
        [grant(ALLOCATION_UUID)],
        '2026-09-06T00:00:00.000Z',
        'reconciliation_v2'
      )
      closeDatabase(database)

      const crash = startFreshProcess(sandbox, workerSource, `allocation-${scenario.stage}`, {
        POS_RECOVERY_COMMAND: 'crash',
        POS_RECOVERY_STAGE: scenario.stage,
        POS_RECOVERY_MARKER_DIRECTORY: sandbox.root
      })
      const marker = await crash.waitForMarker(crashMarkerPath(sandbox.root))
      const markerRecovery = recoveryOf(marker)
      equal(marker.crashStage, scenario.stage)
      equal(markerRecovery.state, scenario.markerRecoveryState)
      equal(marker.grantStatus, scenario.markerGrantStatus)
      equal(marker.spendableMilli, 0)
      equal(marker.usableGrantCount, 0)

      crash.kill('SIGKILL')
      const killed = await crash.wait()
      equal(killed.status, null)
      equal(killed.signal, 'SIGKILL')
      equal(killed.killedBySignal, true)
      equal(killed.result, null)

      const reopened = await runWorker(sandbox, 'inspect')
      const persisted = recoveryOf(reopened)
      equal(persisted.state, scenario.rolledBackState)
      equal(reopened.dependencyCount, 0)
      equal(reopened.journalCount, 0)
      equal(reopened.spendableMilli, 0)
      equal(reopened.usableGrantCount, 0)

      if (scenario.rolledBackState === 'intent') {
        equal(persisted.acknowledgeIdempotencyKey, null)
        equal(reopened.grantStatus, 'active')
      } else {
        equal(persisted.acknowledgeIdempotencyKey, markerRecovery.acknowledgeIdempotencyKey)
        equal(persisted.terminalSequence, 0)
        equal(persisted.terminalConsumedQuantityMilli, 0)
        equal(persisted.terminalHash, markerRecovery.terminalHash)
        equal(reopened.grantStatus, 'revocation_pending')
      }

      const resumed = await runWorker(sandbox, 'resume')
      const completed = recoveryOf(resumed)
      equal(completed.state, 'acknowledged')
      equal(completed.requestSealIdempotencyKey, persisted.requestSealIdempotencyKey)
      equal(resumed.grantStatus, 'seal_acknowledged')
      equal(resumed.grantLifecycleGeneration, 2)
      equal(resumed.dependencyCount, 0)
      equal(resumed.journalCount, 0)
      equal(resumed.spendableMilli, 0)
      equal(resumed.usableGrantCount, 0)

      const markerRequests = marker[
        scenario.requestKind === 'seal' ? 'sealRequests' : 'acknowledgementRequests'
      ] as readonly unknown[]
      const resumedRequests = resumed[
        scenario.requestKind === 'seal' ? 'sealRequests' : 'acknowledgementRequests'
      ] as readonly unknown[]
      equal(markerRequests.length, 1)
      equal(resumedRequests.length, 1)
      deepEqual(resumedRequests[0], markerRequests[0])

      if (scenario.rolledBackState === 'sealed') {
        equal(completed.acknowledgeIdempotencyKey, persisted.acknowledgeIdempotencyKey)
        equal(completed.terminalHash, persisted.terminalHash)
      }
    }
  )
}
