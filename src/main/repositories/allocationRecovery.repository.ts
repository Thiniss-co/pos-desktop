import { randomUUID } from 'crypto'
import type { SqliteDatabase } from '../database/connection'
import {
  allocationJournalChainHash,
  allocationJournalInitialHash,
  isSha256Hex
} from '../services/allocationJournal'
import type { StockAllocationRepository } from './stockAllocation.repository'

export type AllocationRecoveryState = 'intent' | 'sealed' | 'acknowledged' | 'terminal' | 'conflict'

export interface AllocationRecoveryRow {
  readonly allocationUuid: string
  readonly rightsGeneration: number
  readonly companyUuid: string
  readonly deviceUuid: string
  readonly state: AllocationRecoveryState
  readonly requestSealIdempotencyKey: string
  readonly expectedLifecycleGeneration: number
  readonly sealGeneration: number | null
  readonly sealNonce: string | null
  readonly terminalSequence: number | null
  readonly terminalConsumedQuantityMilli: number | null
  readonly terminalHash: string | null
  readonly acknowledgeIdempotencyKey: string | null
}

interface RecoveryDbRow {
  readonly allocation_uuid: string
  readonly rights_generation: number
  readonly company_uuid: string
  readonly device_uuid: string
  readonly state: AllocationRecoveryState
  readonly request_seal_idempotency_key: string
  readonly expected_lifecycle_generation: number
  readonly seal_generation: number | null
  readonly seal_nonce: string | null
  readonly terminal_sequence: number | null
  readonly terminal_consumed_quantity_milli: number | null
  readonly terminal_hash: string | null
  readonly acknowledge_idempotency_key: string | null
}

function mapRecovery(row: RecoveryDbRow): AllocationRecoveryRow {
  return {
    allocationUuid: row.allocation_uuid,
    rightsGeneration: row.rights_generation,
    companyUuid: row.company_uuid,
    deviceUuid: row.device_uuid,
    state: row.state,
    requestSealIdempotencyKey: row.request_seal_idempotency_key,
    expectedLifecycleGeneration: row.expected_lifecycle_generation,
    sealGeneration: row.seal_generation,
    sealNonce: row.seal_nonce,
    terminalSequence: row.terminal_sequence,
    terminalConsumedQuantityMilli: row.terminal_consumed_quantity_milli,
    terminalHash: row.terminal_hash,
    acknowledgeIdempotencyKey: row.acknowledge_idempotency_key
  }
}

export class AllocationRecoveryRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly stockAllocations: StockAllocationRepository
  ) {}

  beginIntent(input: {
    readonly allocationUuid: string
    readonly companyUuid: string
    readonly deviceUuid: string
    readonly nowIso: string
  }): AllocationRecoveryRow {
    const grant = this.stockAllocations.findGrantByUuid(input.allocationUuid)

    if (
      grant === null ||
      grant.companyUuid !== input.companyUuid ||
      grant.deviceUuid !== input.deviceUuid ||
      grant.status !== 'active'
    ) {
      throw new Error('Only an active allocation owned by this device can begin recovery')
    }

    this.database
      .prepare(
        `INSERT INTO stock_allocation_recoveries (
           allocation_uuid, rights_generation, company_uuid, device_uuid, state,
           request_seal_idempotency_key, expected_lifecycle_generation,
           intent_created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'intent', ?, ?, ?, ?)
         ON CONFLICT(allocation_uuid, rights_generation) DO NOTHING`
      )
      .run(
        grant.allocationUuid,
        grant.rightsGeneration,
        input.companyUuid,
        input.deviceUuid,
        randomUUID(),
        grant.lifecycleGeneration,
        input.nowIso,
        input.nowIso
      )

    const recovery = this.find(grant.allocationUuid, grant.rightsGeneration)
    if (recovery === null) {
      throw new Error('Allocation recovery intent did not persist')
    }

    return recovery
  }

  find(allocationUuid: string, rightsGeneration: number): AllocationRecoveryRow | null {
    const row = this.database
      .prepare(
        `SELECT * FROM stock_allocation_recoveries
          WHERE allocation_uuid = ? AND rights_generation = ?`
      )
      .get(allocationUuid, rightsGeneration) as RecoveryDbRow | undefined

    return row ? mapRecovery(row) : null
  }

  listForOwner(companyUuid: string, deviceUuid: string): readonly AllocationRecoveryRow[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM stock_allocation_recoveries
            WHERE company_uuid = ? AND device_uuid = ?
              AND state IN ('intent','sealed','acknowledged')
            ORDER BY intent_created_at, allocation_uuid`
        )
        .all(companyUuid, deviceUuid) as RecoveryDbRow[]
    ).map(mapRecovery)
  }

  freezeDeclaration(input: {
    readonly recovery: AllocationRecoveryRow
    readonly sealGeneration: number
    readonly sealNonce: string
    readonly nowIso: string
  }): AllocationRecoveryRow {
    const entries = this.stockAllocations.journalEntriesFor(
      input.recovery.allocationUuid,
      input.recovery.rightsGeneration
    )
    const terminalSequence = entries.length
    const terminalQuantity = entries.reduce((total, entry) => total + entry.quantityMilli, 0)
    const terminalHash = allocationJournalChainHash(
      input.recovery.allocationUuid,
      input.recovery.rightsGeneration,
      entries.map((entry) => {
        if (
          entry.rightsGeneration !== input.recovery.rightsGeneration ||
          entry.invoiceIdempotencyKey === null ||
          entry.itemLineUuid === null ||
          entry.requestHash === null ||
          entry.entryHash === null ||
          entry.chainHash === null
        ) {
          throw new Error(
            'The final local allocation journal contains incomplete immutable evidence'
          )
        }

        return {
          allocationUuid: entry.allocationUuid,
          rightsGeneration: entry.rightsGeneration,
          consumptionSequence: entry.consumptionSequence,
          localConsumptionUuid: entry.localUuid,
          invoiceIdempotencyKey: entry.invoiceIdempotencyKey,
          itemLineUuid: entry.itemLineUuid,
          quantityMilli: entry.quantityMilli,
          requestHash: entry.requestHash,
          entryHash: entry.entryHash,
          chainHash: entry.chainHash
        }
      })
    )

    if (!isSha256Hex(terminalHash)) {
      throw new Error('The final local allocation journal is not reconstructable')
    }

    const update = this.database
      .prepare(
        `UPDATE stock_allocation_recoveries
            SET state = 'sealed', seal_generation = ?, seal_nonce = ?, terminal_sequence = ?,
                terminal_consumed_quantity_milli = ?, terminal_hash = ?,
                acknowledge_idempotency_key = ?, sealed_at = ?, updated_at = ?
          WHERE allocation_uuid = ? AND rights_generation = ? AND state = 'intent'`
      )
      .run(
        input.sealGeneration,
        input.sealNonce,
        terminalSequence,
        terminalQuantity,
        terminalHash,
        randomUUID(),
        input.nowIso,
        input.nowIso,
        input.recovery.allocationUuid,
        input.recovery.rightsGeneration
      )

    if (update.changes !== 1) {
      throw new Error('Allocation recovery changed before the final declaration was frozen')
    }

    const insert = this.database.prepare(
      `INSERT INTO stock_allocation_recovery_dependencies (
         allocation_uuid, rights_generation, local_consumption_uuid, invoice_local_uuid,
         invoice_idempotency_key, item_line_uuid, consumption_sequence, quantity_milli,
         request_hash, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )

    for (const entry of entries) {
      insert.run(
        input.recovery.allocationUuid,
        input.recovery.rightsGeneration,
        entry.localUuid,
        entry.invoiceLocalUuid,
        entry.invoiceIdempotencyKey,
        entry.itemLineUuid,
        entry.consumptionSequence,
        entry.quantityMilli,
        entry.requestHash,
        input.nowIso,
        input.nowIso
      )
    }

    return this.find(
      input.recovery.allocationUuid,
      input.recovery.rightsGeneration
    ) as AllocationRecoveryRow
  }

  refreshDependencyEvidence(recovery: AllocationRecoveryRow, nowIso: string): number {
    const boundary = this.stockAllocations.findCoverageBoundary(
      recovery.allocationUuid,
      recovery.rightsGeneration
    )

    if (boundary !== null) {
      this.database
        .prepare(
          `UPDATE stock_allocation_recovery_dependencies
              SET resolved_at = COALESCE(resolved_at, ?),
                  resolution_source = COALESCE(resolution_source, ?), updated_at = ?
            WHERE allocation_uuid = ? AND rights_generation = ?
              AND consumption_sequence <= ?`
        )
        .run(
          nowIso,
          boundary.source,
          nowIso,
          recovery.allocationUuid,
          recovery.rightsGeneration,
          boundary.acceptedConsumptionSequence
        )
    }

    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM stock_allocation_recovery_dependencies
          WHERE allocation_uuid = ? AND rights_generation = ? AND resolved_at IS NULL`
      )
      .get(recovery.allocationUuid, recovery.rightsGeneration) as { readonly count: number }

    return row.count
  }

  assertFrozenDeclarationComplete(recovery: AllocationRecoveryRow): void {
    if (
      recovery.terminalSequence === null ||
      recovery.terminalConsumedQuantityMilli === null ||
      recovery.terminalHash === null
    ) {
      throw new Error('The allocation recovery has no frozen terminal declaration')
    }

    const entries = this.stockAllocations.journalEntriesFor(
      recovery.allocationUuid,
      recovery.rightsGeneration
    )
    const dependencies = this.database
      .prepare(
        `SELECT * FROM stock_allocation_recovery_dependencies
          WHERE allocation_uuid = ? AND rights_generation = ?
          ORDER BY consumption_sequence`
      )
      .all(recovery.allocationUuid, recovery.rightsGeneration) as Record<string, unknown>[]

    if (entries.length !== recovery.terminalSequence || dependencies.length !== entries.length) {
      throw new Error('The frozen recovery dependency set is incomplete')
    }

    const quantity = entries.reduce((total, entry, index) => {
      const dependency = dependencies[index]
      if (
        entry.consumptionSequence !== index + 1 ||
        entry.rightsGeneration !== recovery.rightsGeneration ||
        entry.invoiceIdempotencyKey === null ||
        entry.itemLineUuid === null ||
        entry.requestHash === null ||
        entry.entryHash === null ||
        entry.chainHash === null ||
        dependency.local_consumption_uuid !== entry.localUuid ||
        dependency.invoice_local_uuid !== entry.invoiceLocalUuid ||
        dependency.invoice_idempotency_key !== entry.invoiceIdempotencyKey ||
        dependency.item_line_uuid !== entry.itemLineUuid ||
        dependency.consumption_sequence !== entry.consumptionSequence ||
        dependency.quantity_milli !== entry.quantityMilli ||
        dependency.request_hash !== entry.requestHash ||
        dependency.resolved_at === null
      ) {
        throw new Error('A declared recovery entry lacks matching authoritative evidence')
      }

      return total + entry.quantityMilli
    }, 0)

    const hash =
      entries.length === 0
        ? allocationJournalInitialHash(recovery.allocationUuid, recovery.rightsGeneration)
        : allocationJournalChainHash(
            recovery.allocationUuid,
            recovery.rightsGeneration,
            entries.map((entry) => ({
              allocationUuid: entry.allocationUuid,
              rightsGeneration: entry.rightsGeneration as number,
              consumptionSequence: entry.consumptionSequence,
              localConsumptionUuid: entry.localUuid,
              invoiceIdempotencyKey: entry.invoiceIdempotencyKey as string,
              itemLineUuid: entry.itemLineUuid as string,
              quantityMilli: entry.quantityMilli,
              requestHash: entry.requestHash as string,
              entryHash: entry.entryHash,
              chainHash: entry.chainHash
            }))
          )

    if (quantity !== recovery.terminalConsumedQuantityMilli || hash !== recovery.terminalHash) {
      throw new Error('The current local journal no longer matches the frozen declaration')
    }
  }

  unresolvedInvoiceUuids(recovery: AllocationRecoveryRow): readonly string[] {
    return (
      this.database
        .prepare(
          `SELECT DISTINCT invoice_local_uuid FROM stock_allocation_recovery_dependencies
            WHERE allocation_uuid = ? AND rights_generation = ? AND resolved_at IS NULL
            ORDER BY consumption_sequence`
        )
        .all(recovery.allocationUuid, recovery.rightsGeneration) as {
        readonly invoice_local_uuid: string
      }[]
    ).map((row) => row.invoice_local_uuid)
  }

  markState(
    recovery: AllocationRecoveryRow,
    state: Extract<AllocationRecoveryState, 'acknowledged' | 'terminal' | 'conflict'>,
    nowIso: string,
    conflictReason: string | null = null
  ): void {
    this.database
      .prepare(
        `UPDATE stock_allocation_recoveries SET state = ?, conflict_reason = ?,
           acknowledged_at = CASE WHEN ? = 'acknowledged' THEN ? ELSE acknowledged_at END,
           terminal_at = CASE WHEN ? = 'terminal' THEN ? ELSE terminal_at END,
           updated_at = ?
         WHERE allocation_uuid = ? AND rights_generation = ?`
      )
      .run(
        state,
        conflictReason,
        state,
        nowIso,
        state,
        nowIso,
        nowIso,
        recovery.allocationUuid,
        recovery.rightsGeneration
      )
  }

  markTerminalObservation(allocationUuid: string, nowIso: string): void {
    this.database
      .prepare(
        `UPDATE stock_allocation_recoveries
            SET state = 'terminal', terminal_at = COALESCE(terminal_at, ?), updated_at = ?
          WHERE allocation_uuid = ? AND state IN ('sealed','acknowledged','terminal')`
      )
      .run(nowIso, nowIso, allocationUuid)
  }
}
