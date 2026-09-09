import {
  stockAllocationAcknowledgeSealRoute,
  stockAllocationSealRoute
} from '@shared/constants/apiRoutes'
import type { SqliteDatabase } from '../database/connection'
import { runSerializedWrite } from '../database/serializedWrite'
import { isPublicAppError } from '../http/apiError'
import type { DesktopApiClient } from '../http/desktopApiClient'
import { stockAllocationResourceSchema } from '../http/desktopResources.contract'
import type {
  AllocationRecoveryRepository,
  AllocationRecoveryRow
} from '../repositories/allocationRecovery.repository'
import type { StockAllocationRepository } from '../repositories/stockAllocation.repository'
import type { SyncQueueRepository } from '../repositories/syncQueue.repository'
import { uploadInvoice } from '../sync/invoiceUpload.client'
import type { AllocationReconciliationService } from './allocationReconciliation.service'
import type { CommercialAccessService } from './commercialAccess.service'
import { payloadHash } from './localSale.fingerprint'

const INVOICE_UPLOAD_PERMISSION = 'pos.invoice.upload'

export interface AllocationRecoveryOwner {
  readonly companyUuid: string
  readonly deviceUuid: string
}

export interface AllocationRecoveryDependencies {
  readonly database: SqliteDatabase
  readonly apiClient: Pick<DesktopApiClient, 'requestWithMeta'>
  readonly recoveries: AllocationRecoveryRepository
  readonly stockAllocations: StockAllocationRepository
  readonly syncQueue: Pick<SyncQueueRepository, 'frozenInvoiceReplayFor'>
  readonly reconciliation: Pick<AllocationReconciliationService, 'applyCoverage'>
  readonly commercialAccess: Pick<CommercialAccessService, 'assertAllowed'>
  readonly permissions: { hasPermission(permission: string): boolean }
  readonly owner: () => AllocationRecoveryOwner | null
  readonly now?: () => Date
}

/**
 * Durable, restart-safe cooperative sealing. Every SQLite boundary is short and synchronous; every
 * HTTP request happens after commit and current sync authority is rechecked immediately before it.
 */
export class AllocationRecoveryService {
  private readonly now: () => Date
  private operation: Promise<void> = Promise.resolve()

  constructor(private readonly dependencies: AllocationRecoveryDependencies) {
    this.now = dependencies.now ?? (() => new Date())
  }

  async start(allocationUuid: string): Promise<void> {
    return this.enqueue(() => this.startNow(allocationUuid))
  }

  async resume(): Promise<void> {
    return this.enqueue(() => this.resumeNow())
  }

  private async startNow(allocationUuid: string): Promise<void> {
    const owner = this.requireOwner()
    const recovery = runSerializedWrite(this.dependencies.database, () =>
      this.dependencies.recoveries.beginIntent({
        allocationUuid,
        ...owner,
        nowIso: this.now().toISOString()
      })
    )

    await this.advance(recovery)
  }

  private async resumeNow(): Promise<void> {
    const owner = this.requireOwner()
    for (const recovery of this.dependencies.recoveries.listForOwner(
      owner.companyUuid,
      owner.deviceUuid
    )) {
      await this.advance(recovery)
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const scheduled = this.operation.then(operation, operation)
    this.operation = scheduled.catch(() => undefined)
    return scheduled
  }

  private async advance(initial: AllocationRecoveryRow): Promise<void> {
    let recovery = initial

    if (recovery.state === 'intent') {
      this.authorizeSync()
      const response = await this.dependencies.apiClient.requestWithMeta(
        stockAllocationSealRoute(recovery.allocationUuid),
        {
          idempotency_key: recovery.requestSealIdempotencyKey,
          expected_generation: recovery.expectedLifecycleGeneration
        }
      )
      const allocation = stockAllocationResourceSchema.parse(response.data)

      recovery = runSerializedWrite(this.dependencies.database, () => {
        this.assertSealResponse(recovery, allocation)
        this.dependencies.stockAllocations.observeRecoveryLifecycle({
          allocationUuid: allocation.id,
          rightsGeneration: allocation.rights_generation,
          lifecycleGeneration: allocation.lifecycle_generation,
          status: 'revocation_pending',
          sealNonce: allocation.seal_nonce,
          finalConsumptionSequence: allocation.final_consumption_sequence,
          finalConsumptionHash: allocation.final_consumption_hash,
          sealedAt: allocation.sealed_at,
          acknowledgedAt: allocation.acknowledged_at,
          releasedAt: allocation.released_at,
          updatedAt: this.now().toISOString()
        })

        return this.dependencies.recoveries.freezeDeclaration({
          recovery,
          sealGeneration: allocation.lifecycle_generation,
          sealNonce: allocation.seal_nonce as string,
          nowIso: this.now().toISOString()
        })
      })
    }

    if (recovery.state !== 'sealed') {
      return
    }

    this.resolveObservedDependencies(recovery)

    for (const invoiceUuid of this.dependencies.recoveries.unresolvedInvoiceUuids(recovery)) {
      this.authorizeInvoiceReplay()
      const queued = this.dependencies.syncQueue.frozenInvoiceReplayFor(invoiceUuid)

      if (queued === null || payloadHash(JSON.parse(queued.payloadJson)) !== queued.payloadHash) {
        this.markConflict(recovery, 'missing_or_changed_frozen_invoice_upload')
        return
      }

      try {
        const accepted = await uploadInvoice(this.dependencies.apiClient, queued.payloadJson)

        runSerializedWrite(this.dependencies.database, () => {
          for (const boundary of accepted.coverage ?? []) {
            this.dependencies.reconciliation.applyCoverage(
              boundary,
              { companyUuid: recovery.companyUuid, deviceUuid: recovery.deviceUuid },
              'invoice_upload',
              this.now().toISOString()
            )
          }
        })
      } catch (error) {
        // A generic 409 does not prove a missing invoice. Preserve a deterministic conflict rather
        // than converting it into an endless retry; transport failures remain sealed for replay.
        if (isPublicAppError(error) && error.category === 'conflict') {
          this.markConflict(recovery, error.backendCode ?? 'invoice_replay_conflict')
        }
        return
      }

      this.resolveObservedDependencies(recovery)
    }

    const proof = runSerializedWrite(this.dependencies.database, () => {
      if (
        this.dependencies.recoveries.refreshDependencyEvidence(
          recovery,
          this.now().toISOString()
        ) !== 0
      ) {
        return null
      }

      const current = this.dependencies.recoveries.find(
        recovery.allocationUuid,
        recovery.rightsGeneration
      )

      if (current?.state !== 'sealed') {
        return null
      }

      this.dependencies.recoveries.assertFrozenDeclarationComplete(current)

      return current
    })

    if (
      proof === null ||
      proof.sealGeneration === null ||
      proof.sealNonce === null ||
      proof.terminalSequence === null ||
      proof.terminalConsumedQuantityMilli === null ||
      proof.terminalHash === null ||
      proof.acknowledgeIdempotencyKey === null
    ) {
      return
    }

    this.authorizeSync()
    const response = await this.dependencies.apiClient.requestWithMeta(
      stockAllocationAcknowledgeSealRoute(proof.allocationUuid),
      {
        idempotency_key: proof.acknowledgeIdempotencyKey,
        rights_generation: proof.rightsGeneration,
        seal_generation: proof.sealGeneration,
        seal_nonce: proof.sealNonce,
        terminal_sequence: proof.terminalSequence,
        terminal_hash: proof.terminalHash,
        seal_proof_version: 2,
        terminal_consumed_quantity_milli: proof.terminalConsumedQuantityMilli
      }
    )
    const acknowledged = stockAllocationResourceSchema.parse(response.data)

    runSerializedWrite(this.dependencies.database, () => {
      if (
        acknowledged.id !== proof.allocationUuid ||
        acknowledged.rights_generation !== proof.rightsGeneration ||
        acknowledged.lifecycle_generation !== proof.sealGeneration ||
        acknowledged.seal_nonce !== proof.sealNonce ||
        !['seal_acknowledged', 'released', 'consumed'].includes(acknowledged.status)
      ) {
        throw new Error('The seal acknowledgement does not match the frozen declaration')
      }

      this.dependencies.stockAllocations.observeRecoveryLifecycle({
        allocationUuid: acknowledged.id,
        rightsGeneration: acknowledged.rights_generation,
        lifecycleGeneration: acknowledged.lifecycle_generation,
        status: acknowledged.status as 'seal_acknowledged' | 'released' | 'consumed',
        sealNonce: acknowledged.seal_nonce,
        finalConsumptionSequence: acknowledged.final_consumption_sequence,
        finalConsumptionHash: acknowledged.final_consumption_hash,
        sealedAt: acknowledged.sealed_at,
        acknowledgedAt: acknowledged.acknowledged_at,
        releasedAt: acknowledged.released_at,
        updatedAt: this.now().toISOString()
      })
      this.dependencies.recoveries.markState(
        proof,
        acknowledged.status === 'seal_acknowledged' ? 'acknowledged' : 'terminal',
        this.now().toISOString()
      )
    })
  }

  private resolveObservedDependencies(recovery: AllocationRecoveryRow): void {
    runSerializedWrite(this.dependencies.database, () => {
      this.dependencies.recoveries.refreshDependencyEvidence(recovery, this.now().toISOString())
    })
  }

  private authorizeSync(): void {
    this.dependencies.commercialAccess.assertAllowed('sync')
  }

  private requireOwner(): AllocationRecoveryOwner {
    const owner = this.dependencies.owner()
    if (owner === null) {
      throw new Error('An authenticated company/device owner is required for allocation recovery')
    }

    return owner
  }

  private authorizeInvoiceReplay(): void {
    this.authorizeSync()
    if (!this.dependencies.permissions.hasPermission(INVOICE_UPLOAD_PERMISSION)) {
      throw new Error('Current invoice-upload permission is required for recovery replay')
    }
  }

  private assertSealResponse(
    recovery: AllocationRecoveryRow,
    allocation: ReturnType<typeof stockAllocationResourceSchema.parse>
  ): void {
    if (
      allocation.id !== recovery.allocationUuid ||
      allocation.company_uuid !== recovery.companyUuid ||
      allocation.device_uuid !== recovery.deviceUuid ||
      allocation.rights_generation !== recovery.rightsGeneration ||
      allocation.lifecycle_generation !== recovery.expectedLifecycleGeneration + 1 ||
      allocation.status !== 'revocation_pending' ||
      allocation.seal_nonce === null
    ) {
      throw new Error('The seal response does not match the durable recovery intent')
    }
  }

  private markConflict(recovery: AllocationRecoveryRow, reason: string): void {
    runSerializedWrite(this.dependencies.database, () => {
      this.dependencies.recoveries.markState(recovery, 'conflict', this.now().toISOString(), reason)
    })
  }
}
