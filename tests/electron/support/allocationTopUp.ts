/**
 * Shared scaffolding for the CP-5D exact-deficit acquisition suite.
 *
 * Everything below the HTTP boundary is production code running against the real file-backed
 * Electron SQLite database: `StockAllocationRepository`, `StockAllocationService`,
 * `AllocationAcquisitionService`, `LocalSaleService`, and `SaleCompletionService`. Only the network
 * itself is substituted, so persistence, atomicity, replay, crash, concurrency, and zero-write
 * claims are proven by the database rather than by a mock.
 */

import type { SqliteDatabase } from '../../../src/main/database/connection'
import type { DesktopApiRoute } from '../../../src/shared/constants/apiRoutes'
import type { ConnectivitySnapshot } from '../../../src/shared/contracts/connectivity.contract'
import type { StockAllocationResource } from '../../../src/main/http/desktopResources.contract'
import { AllocationAcquisitionService } from '../../../src/main/services/allocationAcquisition.service'
import type { LocalSaleService } from '../../../src/main/services/localSale.service'
import { SaleCompletionService } from '../../../src/main/services/saleCompletion.service'
import { StockAllocationService } from '../../../src/main/services/stockAllocation.service'
import {
  bootstrapResource,
  companyUuid,
  deviceUuid,
  trackedProductUuid,
  warehouseUuid
} from './localSaleFixture'
import type { RealRepositories } from './realRepositories'

export const BOOTSTRAP_ALLOCATION_REVISION = 11

export function allocationEnvelope(
  overrides: Partial<StockAllocationResource> = {}
): StockAllocationResource {
  return {
    id: '70000000-0000-4000-8000-000000000001',
    contract_version: 1,
    company_uuid: companyUuid,
    device_uuid: deviceUuid,
    warehouse_uuid: warehouseUuid,
    product_uuid: trackedProductUuid,
    server_sequence: 1,
    rights_generation: 1,
    lifecycle_generation: 1,
    granted_quantity_milli: 1000,
    consumed_quantity_milli: 0,
    remaining_quantity_milli: 1000,
    consume_until: '2026-01-03T00:00:00+00:00',
    status: 'active',
    envelope_hash: 'd'.repeat(64),
    seal_nonce: null,
    final_consumption_sequence: null,
    final_consumption_hash: null,
    sealed_at: null,
    acknowledged_at: null,
    released_at: null,
    ...overrides
  }
}

/**
 * Re-persists the fixture bootstrap with the allocation capability present. `setUpAuthorizedContext`
 * persists a snapshot from a backend that predates the contract, which is deliberately recorded as
 * `unavailable` and can never authorize a tracked sale or a top-up.
 */
export function enableAllocationCapability(
  repositories: RealRepositories,
  allocations: readonly StockAllocationResource[] = [],
  revision: number = BOOTSTRAP_ALLOCATION_REVISION
): void {
  repositories.bootstrapSnapshot.persistSnapshot(
    bootstrapResource({
      stock_allocations: [...allocations],
      stock_allocation_revision: revision
    }),
    '2026-01-01T00:01:00+00:00'
  )
}

export interface TopUpCall {
  readonly path: string
  readonly body: { readonly idempotency_key: string; readonly items: readonly unknown[] }
}

export type TopUpTransport = (
  call: TopUpCall,
  attempt: number
) => { readonly data: unknown; readonly meta: Record<string, unknown> }

export interface TopUpHarness {
  readonly saleCompletion: SaleCompletionService
  readonly calls: TopUpCall[]
  readonly diagnostics: string[]
}

const onlineSnapshot: ConnectivitySnapshot = {
  status: 'online',
  networkAvailable: true,
  backendReachable: true,
  checkedAt: '2026-01-01T02:00:00Z',
  lastBackendReachableAt: '2026-01-01T02:00:00Z',
  reason: 'probe_succeeded'
}

const offlineSnapshot: ConnectivitySnapshot = {
  status: 'backend_unreachable',
  networkAvailable: true,
  backendReachable: false,
  checkedAt: '2026-01-01T02:00:00Z',
  lastBackendReachableAt: null,
  reason: 'probe_connection_failed'
}

export function grantedResponse(
  allocations: readonly StockAllocationResource[],
  revision = BOOTSTRAP_ALLOCATION_REVISION + 1
): { readonly data: unknown; readonly meta: Record<string, unknown> } {
  return { data: allocations, meta: { allocation_revision: revision, trace_id: 'trace' } }
}

export function buildTopUpHarness(params: {
  readonly database: SqliteDatabase
  readonly repositories: RealRepositories
  readonly localSale: LocalSaleService
  readonly transport?: TopUpTransport
  readonly online?: boolean
  readonly preconditionsFail?: boolean
}): TopUpHarness {
  const calls: TopUpCall[] = []
  const diagnostics: string[] = []
  let attempt = 0

  const acquisition = new AllocationAcquisitionService({
    database: params.database,
    apiClient: {
      assertRequestPreconditions: (): void => {
        if (params.preconditionsFail) {
          throw new Error('preconditions')
        }
      },
      requestWithMeta: async <T>(route: DesktopApiRoute, body?: unknown) => {
        const call = { path: route.path, body: body as TopUpCall['body'] }
        calls.push(call)
        attempt += 1

        if (!params.transport) {
          throw new Error('No transport was configured for this test')
        }

        return params.transport(call, attempt) as { data: T; meta: Record<string, unknown> }
      }
    },
    stockAllocations: params.repositories.stockAllocations,
    allocationService: new StockAllocationService(params.repositories.stockAllocations),
    connectivity: {
      getSnapshot: () => (params.online === false ? offlineSnapshot : onlineSnapshot)
    },
    log: (line) => diagnostics.push(line)
  })

  return {
    saleCompletion: new SaleCompletionService({
      localSale: params.localSale,
      acquisition,
      now: () => new Date('2026-01-01T02:00:00.000Z')
    }),
    calls,
    diagnostics
  }
}
