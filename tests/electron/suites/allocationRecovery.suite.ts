import { deepEqual, equal, ok, rejects } from 'node:assert/strict'
import { closeDatabase } from '../../../src/main/database/connection'
import { AllocationRecoveryService } from '../../../src/main/services/allocationRecovery.service'
import { payloadHash } from '../../../src/main/services/localSale.fingerprint'
import { databaseTest } from '../support/sandbox'
import { openSandboxDatabaseAtPath, openTestDatabase } from '../support/openTestDatabase'
import { realRepositories } from '../support/realRepositories'
import {
  COMPANY_UUID,
  DEVICE_UUID,
  NOW,
  grant,
  writeInvoiceSkeleton,
  writeLocalJournal
} from '../support/allocationScenario'

const ALLOCATION_UUID = '00000000-0000-4000-8000-000000000451'
const INVOICE_UUID = '00000000-0000-4000-8000-000000000452'
const ITEM_UUID = '00000000-0000-4000-8000-000000000453'
const CONSUMPTION_UUID = '00000000-0000-4000-8000-000000000454'
const SEAL_NONCE = '00000000-0000-4000-8000-000000000456'

function allocationResponse(
  status: 'revocation_pending' | 'seal_acknowledged',
  terminal: { readonly sequence: number; readonly hash: string } | null = null
): Record<string, unknown> {
  return {
    id: ALLOCATION_UUID,
    contract_version: 1,
    company_uuid: COMPANY_UUID,
    device_uuid: DEVICE_UUID,
    warehouse_uuid: '00000000-0000-4000-8000-000000000a01',
    product_uuid: '00000000-0000-4000-8000-000000000b01',
    server_sequence: 1,
    rights_generation: 1,
    lifecycle_generation: 2,
    granted_quantity_milli: 10_000,
    consumed_quantity_milli: terminal === null ? 0 : 1_000,
    remaining_quantity_milli: terminal === null ? 10_000 : 9_000,
    consume_until: '2099-01-01T00:00:00+00:00',
    status,
    envelope_hash: 'a'.repeat(64),
    seal_nonce: SEAL_NONCE,
    final_consumption_sequence: terminal?.sequence ?? null,
    final_consumption_hash: terminal?.hash ?? null,
    sealed_at: '2026-09-06T00:00:00+00:00',
    acknowledged_at: status === 'seal_acknowledged' ? '2026-09-06T00:00:01+00:00' : null,
    released_at: null
  }
}

function recoveryService(
  database: ReturnType<typeof openTestDatabase>,
  requestWithMeta: (route: { readonly path: string }, body?: unknown) => Promise<unknown>
): {
  readonly service: AllocationRecoveryService
  readonly recoveries: ReturnType<typeof realRepositories>['allocationRecoveries']
} {
  const repositories = realRepositories(database)
  const recoveries = repositories.allocationRecoveries

  return {
    recoveries,
    service: new AllocationRecoveryService({
      database,
      apiClient: { requestWithMeta },
      recoveries,
      stockAllocations: repositories.stockAllocations,
      syncQueue: repositories.syncQueue,
      reconciliation: repositories.allocationReconciliation,
      commercialAccess: { assertAllowed: () => undefined },
      permissions: { hasPermission: () => true },
      owner: () => ({ companyUuid: COMPANY_UUID, deviceUuid: DEVICE_UUID }),
      now: () => new Date(NOW)
    } as unknown as ConstructorParameters<typeof AllocationRecoveryService>[0])
  }
}

databaseTest(
  'BH-04B-4 synced-but-uncovered consumption stays a dependency until authoritative coverage arrives',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    repositories.stockAllocations.ingestBootstrapSnapshot(
      1,
      [grant(ALLOCATION_UUID)],
      NOW,
      'reconciliation_v2'
    )
    writeInvoiceSkeleton(database, INVOICE_UUID, ITEM_UUID)
    const boundary = writeLocalJournal(database, ALLOCATION_UUID, 1, [
      {
        localUuid: CONSUMPTION_UUID,
        sequence: 1,
        quantityMilli: 1_000,
        invoiceLocalUuid: INVOICE_UUID,
        itemLocalUuid: ITEM_UUID,
        lineIndex: 0,
        requestHash: 'b'.repeat(64)
      }
    ])
    database
      .prepare(
        `UPDATE local_invoices SET sync_status = 'synced', remote_uuid = ?, server_number = ?,
           synced_at = ?, updated_at = ? WHERE local_uuid = ?`
      )
      .run('00000000-0000-4000-8000-000000000455', 'INV-455', NOW, NOW, INVOICE_UUID)

    const recoveries = repositories.allocationRecoveries
    const intent = recoveries.beginIntent({
      allocationUuid: ALLOCATION_UUID,
      companyUuid: COMPANY_UUID,
      deviceUuid: DEVICE_UUID,
      nowIso: NOW
    })
    equal(repositories.stockAllocations.spendableMilli(ALLOCATION_UUID), 0)
    const sealed = recoveries.freezeDeclaration({
      recovery: intent,
      sealGeneration: 2,
      sealNonce: '00000000-0000-4000-8000-000000000456',
      nowIso: NOW
    })

    equal(recoveries.refreshDependencyEvidence(sealed, NOW), 1)
    equal(recoveries.unresolvedInvoiceUuids(sealed)[0], INVOICE_UUID)
    closeDatabase(database)

    // Restart does not lose intent, the frozen declaration, or the synced-but-uncovered dependency.
    const restarted = openSandboxDatabaseAtPath(sandbox.databasePath)
    const restartedRepositories = realRepositories(restarted)
    const restartedRecoveries = restartedRepositories.allocationRecoveries
    const persisted = restartedRecoveries.find(ALLOCATION_UUID, 1)
    ok(persisted !== null)
    equal(persisted.state, 'sealed')
    equal(restartedRecoveries.refreshDependencyEvidence(persisted, NOW), 1)

    const result = restartedRepositories.allocationReconciliation.applyCoverage(
      boundary,
      { companyUuid: COMPANY_UUID, deviceUuid: DEVICE_UUID },
      'bootstrap',
      NOW
    )
    equal(result.kind, 'accepted')
    equal(restartedRecoveries.refreshDependencyEvidence(persisted, NOW), 0)
    restartedRecoveries.assertFrozenDeclarationComplete(persisted)
    equal(restartedRepositories.stockAllocations.spendableMilli(ALLOCATION_UUID), 0)
    closeDatabase(restarted)
  }
)

databaseTest(
  'BH-04B-4 recovery executes seal, frozen invoice replay, verified coverage, and acknowledgement in order',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    repositories.stockAllocations.ingestBootstrapSnapshot(
      1,
      [grant(ALLOCATION_UUID)],
      NOW,
      'reconciliation_v2'
    )
    writeInvoiceSkeleton(database, INVOICE_UUID, ITEM_UUID, { payloadJson: '{}' })
    database
      .prepare('UPDATE sync_queue SET payload_hash = ? WHERE local_aggregate_uuid = ?')
      .run(payloadHash({}), INVOICE_UUID)
    const boundary = writeLocalJournal(database, ALLOCATION_UUID, 1, [
      {
        localUuid: CONSUMPTION_UUID,
        sequence: 1,
        quantityMilli: 1_000,
        invoiceLocalUuid: INVOICE_UUID,
        itemLocalUuid: ITEM_UUID,
        lineIndex: 0,
        requestHash: 'b'.repeat(64)
      }
    ])
    const calls: { readonly path: string; readonly body: unknown }[] = []
    const { service, recoveries } = recoveryService(database, async (route, body) => {
      calls.push({ path: route.path, body })

      if (route.path.endsWith('/seal')) {
        return {
          data: allocationResponse('revocation_pending'),
          meta: {},
          code: 'ok',
          message: 'ok'
        }
      }
      if (route.path === '/invoices/upload') {
        return {
          data: {
            id: '00000000-0000-4000-8000-000000000457',
            server_number: 'INV-457',
            offline_number: null,
            status: 'completed',
            payment_status: 'paid',
            currency: 'USD',
            subtotal_amount: 1_000,
            discount_total_amount: 0,
            tax_total_amount: 0,
            grand_total_amount: 1_000,
            paid_total_amount: 1_000,
            change_due_amount: 0,
            due_amount: 0,
            sold_at: '2026-09-06T00:00:00+00:00',
            allocations: [
              {
                allocation_uuid: ALLOCATION_UUID,
                rights_generation: 1,
                accepted_consumption_sequence: boundary.acceptedConsumptionSequence,
                accepted_consumed_quantity_milli: boundary.acceptedConsumedQuantityMilli,
                accepted_chain_hash: boundary.acceptedChainHash
              }
            ]
          },
          meta: {},
          code: 'DESKTOP_INVOICE_ALREADY_UPLOADED',
          message: 'ok'
        }
      }

      return {
        data: allocationResponse('seal_acknowledged', {
          sequence: boundary.acceptedConsumptionSequence,
          hash: boundary.acceptedChainHash
        }),
        meta: {},
        code: 'ok',
        message: 'ok'
      }
    })

    await service.start(ALLOCATION_UUID)

    deepEqual(
      calls.map((call) => call.path),
      [
        `/stock-allocations/${ALLOCATION_UUID}/seal`,
        '/invoices/upload',
        `/stock-allocations/${ALLOCATION_UUID}/acknowledge-seal`
      ]
    )
    equal(recoveries.find(ALLOCATION_UUID, 1)?.state, 'acknowledged')
    closeDatabase(database)
  }
)

databaseTest(
  'BH-04B-4 a lost acknowledgement response resumes with the same frozen proof and key',
  async (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    repositories.stockAllocations.ingestBootstrapSnapshot(
      1,
      [grant(ALLOCATION_UUID)],
      NOW,
      'reconciliation_v2'
    )
    const acknowledgementBodies: unknown[] = []
    let loseFirstAcknowledgement = true
    const { service, recoveries } = recoveryService(database, async (route, body) => {
      if (route.path.endsWith('/seal')) {
        return {
          data: allocationResponse('revocation_pending'),
          meta: {},
          code: 'ok',
          message: 'ok'
        }
      }

      acknowledgementBodies.push(body)
      if (loseFirstAcknowledgement) {
        loseFirstAcknowledgement = false
        throw new Error('response lost after server commit')
      }

      const persisted = recoveries.find(ALLOCATION_UUID, 1)
      ok(persisted?.terminalHash)
      return {
        data: allocationResponse('seal_acknowledged', {
          sequence: 0,
          hash: persisted.terminalHash
        }),
        meta: {},
        code: 'ok',
        message: 'ok'
      }
    })

    await rejects(service.start(ALLOCATION_UUID), /response lost/)
    equal(recoveries.find(ALLOCATION_UUID, 1)?.state, 'sealed')
    await service.resume()

    equal(acknowledgementBodies.length, 2)
    deepEqual(acknowledgementBodies[1], acknowledgementBodies[0])
    equal(recoveries.find(ALLOCATION_UUID, 1)?.state, 'acknowledged')
    closeDatabase(database)
  }
)

databaseTest(
  'BH-04B-4 terminal-marker ingestion advances a persisted acknowledged recovery without reviving rights',
  (sandbox) => {
    const database = openTestDatabase(sandbox)
    const repositories = realRepositories(database)
    repositories.stockAllocations.ingestBootstrapSnapshot(
      1,
      [grant(ALLOCATION_UUID)],
      NOW,
      'reconciliation_v2'
    )
    const recoveries = repositories.allocationRecoveries
    const intent = recoveries.beginIntent({
      allocationUuid: ALLOCATION_UUID,
      companyUuid: COMPANY_UUID,
      deviceUuid: DEVICE_UUID,
      nowIso: NOW
    })
    const sealed = recoveries.freezeDeclaration({
      recovery: intent,
      sealGeneration: 2,
      sealNonce: '00000000-0000-4000-8000-000000000456',
      nowIso: NOW
    })
    recoveries.markState(sealed, 'acknowledged', NOW)

    repositories.allocationReconciliation.applyTerminalMarker(
      {
        allocationUuid: ALLOCATION_UUID,
        status: 'released',
        lifecycleGeneration: 2,
        terminalRevision: 9
      },
      { companyUuid: COMPANY_UUID, deviceUuid: DEVICE_UUID },
      NOW
    )

    equal(recoveries.find(ALLOCATION_UUID, 1)?.state, 'terminal')
    equal(repositories.stockAllocations.spendableMilli(ALLOCATION_UUID), 0)
    closeDatabase(database)
  }
)
