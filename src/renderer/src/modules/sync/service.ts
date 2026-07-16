import type { SyncStatus } from '@shared/contracts/sync.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

export interface SyncGateway {
  getStatus(): ReturnType<Window['posApi']['sync']['getStatus']>
}

export class SyncService {
  constructor(private readonly gateway: SyncGateway = window.posApi.sync) {}

  async getStatus(): Promise<SyncStatus> {
    return unwrapIpcResult(await this.gateway.getStatus())
  }
}
