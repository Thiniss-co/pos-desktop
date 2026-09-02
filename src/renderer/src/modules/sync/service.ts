import type {
  SyncFailureCursor,
  SyncFailurePage,
  SyncStatus
} from '@shared/contracts/sync.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

export interface SyncGateway {
  getStatus(): ReturnType<Window['posApi']['sync']['getStatus']>
  uploadNow(): ReturnType<Window['posApi']['sync']['uploadNow']>
  listFailures(
    cursor?: SyncFailureCursor | null
  ): ReturnType<Window['posApi']['sync']['listFailures']>
  onChanged(listener: (status: SyncStatus) => void): () => void
}

export class SyncService {
  constructor(private readonly gateway: SyncGateway = window.posApi.sync) {}

  async getStatus(): Promise<SyncStatus> {
    return unwrapIpcResult(await this.gateway.getStatus())
  }

  /**
   * Asks main to schedule a drain. This is a hint: main re-runs the entire authorization gate
   * before anything is dispatched, so a renderer that calls it while paused simply learns it is
   * still paused.
   */
  async uploadNow(): Promise<SyncStatus> {
    return unwrapIpcResult(await this.gateway.uploadNow())
  }

  async listFailures(cursor: SyncFailureCursor | null = null): Promise<SyncFailurePage> {
    return unwrapIpcResult(await this.gateway.listFailures(cursor))
  }

  onChanged(listener: (status: SyncStatus) => void): () => void {
    return this.gateway.onChanged(listener)
  }
}
