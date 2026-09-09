import type { SqliteDatabase } from '../../../src/main/database/connection'
import { AllocationRecoveryService } from '../../../src/main/services/allocationRecovery.service'
import { allocationJournalInitialHash } from '../../../src/main/services/allocationJournal'
import { COMPANY_UUID, DEVICE_UUID, NOW, PRODUCT_UUID, WAREHOUSE_UUID } from './allocationScenario'
import { failingDatabase } from './failingDatabase'
import { openSandboxDatabaseAtPath } from './openTestDatabase'
import { realRepositories } from './realRepositories'
import { parkUntilKilled, parkUntilKilledSync, publishCrashMarker } from './uploadCrash'

const RESULT_PREFIX = '@@RESULT@@'
const ALLOCATION_UUID = '00000000-0000-4000-8000-000000000451'
const SEAL_NONCE = '00000000-0000-4000-8000-000000000456'

type CrashStage =
  | 'after-intent-before-seal-response'
  | 'during-seal-outcome'
  | 'after-seal-outcome-before-ack-response'
  | 'ack-response-received-before-outcome'
  | 'during-ack-outcome'

function emit(value: Record<string, unknown>): void {
  console.log(RESULT_PREFIX + JSON.stringify(value))
}

const databasePath = process.env.POS_ITEST_DB_PATH
const command = process.env.POS_RECOVERY_COMMAND
const markerDirectory = process.env.POS_RECOVERY_MARKER_DIRECTORY
const crashStage = process.env.POS_RECOVERY_STAGE as CrashStage | undefined

if (!databasePath || !command) {
  throw new Error('allocationRecoveryCrashWorker requires a database path and command')
}

const database = openSandboxDatabaseAtPath(databasePath)

function snapshot(connection: SqliteDatabase = database): Record<string, unknown> {
  const repositories = realRepositories(connection)
  const recovery = repositories.allocationRecoveries.find(ALLOCATION_UUID, 1)
  const grant = repositories.stockAllocations.findGrantByUuid(ALLOCATION_UUID)
  const dependencies = connection
    .prepare(
      `SELECT COUNT(*) AS count FROM stock_allocation_recovery_dependencies
        WHERE allocation_uuid = ? AND rights_generation = 1`
    )
    .get(ALLOCATION_UUID) as { readonly count: number }

  return {
    recovery,
    grantStatus: grant?.status ?? null,
    grantLifecycleGeneration: grant?.lifecycleGeneration ?? null,
    grantSealNonce: grant?.sealNonce ?? null,
    dependencyCount: dependencies.count,
    journalCount: repositories.stockAllocations.journalEntriesFor(ALLOCATION_UUID, 1).length,
    spendableMilli: repositories.stockAllocations.spendableMilli(ALLOCATION_UUID),
    usableGrantCount: repositories.stockAllocations.usableGrantsForProduct(
      { companyUuid: COMPANY_UUID, deviceUuid: DEVICE_UUID, warehouseUuid: WAREHOUSE_UUID },
      PRODUCT_UUID,
      NOW
    ).length
  }
}

function publishBoundary(extra: Record<string, unknown>): void {
  if (!markerDirectory) {
    throw new Error('A marker directory is required for a crash command')
  }

  publishCrashMarker(markerDirectory, { ...snapshot(), ...extra })
}

function allocationResponse(
  status: 'revocation_pending' | 'seal_acknowledged'
): Record<string, unknown> {
  const terminalHash = allocationJournalInitialHash(ALLOCATION_UUID, 1)

  return {
    id: ALLOCATION_UUID,
    contract_version: 1,
    company_uuid: COMPANY_UUID,
    device_uuid: DEVICE_UUID,
    warehouse_uuid: WAREHOUSE_UUID,
    product_uuid: PRODUCT_UUID,
    server_sequence: 1,
    rights_generation: 1,
    lifecycle_generation: 2,
    granted_quantity_milli: 10_000,
    consumed_quantity_milli: 0,
    remaining_quantity_milli: 10_000,
    consume_until: '2099-01-01T00:00:00+00:00',
    status,
    envelope_hash: 'a'.repeat(64),
    seal_nonce: SEAL_NONCE,
    final_consumption_sequence: status === 'seal_acknowledged' ? 0 : null,
    final_consumption_hash: status === 'seal_acknowledged' ? terminalHash : null,
    sealed_at: '2026-09-06T00:00:00+00:00',
    acknowledged_at: status === 'seal_acknowledged' ? '2026-09-06T00:00:01+00:00' : null,
    released_at: null
  }
}

const sealRequests: unknown[] = []
const acknowledgementRequests: unknown[] = []
let acknowledgementResponseReturned = false

let serviceDatabase: SqliteDatabase = database

if (
  command === 'crash' &&
  (crashStage === 'during-seal-outcome' || crashStage === 'during-ack-outcome')
) {
  serviceDatabase = failingDatabase(database, {
    afterWrite: (statementSql) => {
      const isSealOutcome =
        crashStage === 'during-seal-outcome' &&
        statementSql.includes('UPDATE stock_allocation_recoveries') &&
        statementSql.includes("SET state = 'sealed'")
      const isAcknowledgementOutcome =
        crashStage === 'during-ack-outcome' &&
        acknowledgementResponseReturned &&
        statementSql.includes('UPDATE stock_allocation_grants')

      if (isSealOutcome || isAcknowledgementOutcome) {
        publishBoundary({ crashStage, sealRequests, acknowledgementRequests })
        parkUntilKilledSync()
      }
    }
  })
}

if (command === 'crash' && crashStage === 'ack-response-received-before-outcome') {
  serviceDatabase = new Proxy(serviceDatabase, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)

      if (property === 'transaction' && typeof value === 'function') {
        return (...arguments_: unknown[]) => {
          if (acknowledgementResponseReturned) {
            publishBoundary({ crashStage, sealRequests, acknowledgementRequests })
            parkUntilKilledSync()
          }

          return Reflect.apply(value, target, arguments_)
        }
      }

      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

const repositories = realRepositories(serviceDatabase)
const service = new AllocationRecoveryService({
  database: serviceDatabase,
  apiClient: {
    requestWithMeta: async (route, body) => {
      if (route.path.endsWith('/seal')) {
        sealRequests.push(body)

        if (command === 'crash' && crashStage === 'after-intent-before-seal-response') {
          publishBoundary({ crashStage, sealRequests, acknowledgementRequests })
          await parkUntilKilled()
        }

        return {
          data: allocationResponse('revocation_pending'),
          meta: {},
          code: 'ok',
          message: 'ok'
        }
      }

      acknowledgementRequests.push(body)

      if (command === 'crash' && crashStage === 'after-seal-outcome-before-ack-response') {
        publishBoundary({ crashStage, sealRequests, acknowledgementRequests })
        await parkUntilKilled()
      }

      const response = {
        data: allocationResponse('seal_acknowledged'),
        meta: {},
        code: 'ok',
        message: 'ok'
      }
      acknowledgementResponseReturned = true
      return response
    }
  },
  recoveries: repositories.allocationRecoveries,
  stockAllocations: repositories.stockAllocations,
  syncQueue: repositories.syncQueue,
  reconciliation: repositories.allocationReconciliation,
  commercialAccess: { assertAllowed: () => undefined },
  permissions: { hasPermission: () => true },
  owner: () => ({ companyUuid: COMPANY_UUID, deviceUuid: DEVICE_UUID }),
  now: () => new Date(NOW)
} as unknown as ConstructorParameters<typeof AllocationRecoveryService>[0])

async function main(): Promise<void> {
  try {
    if (command === 'inspect') {
      emit(snapshot(serviceDatabase))
    } else if (command === 'resume') {
      await service.resume()
      emit({ ...snapshot(serviceDatabase), sealRequests, acknowledgementRequests })
    } else if (command === 'crash') {
      if (!crashStage) {
        throw new Error('A crash stage is required')
      }
      await service.start(ALLOCATION_UUID)
      emit({ outcome: 'survived-the-crash-boundary' })
    } else {
      throw new Error(`Unknown allocation recovery worker command: ${command}`)
    }

    database.close()
  } catch (error) {
    database.close()
    emit({
      outcome: 'worker-error',
      message: error instanceof Error ? error.message : String(error)
    })
    process.exitCode = 1
  }
}

void main()
