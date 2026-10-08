import type { UpdateRestartResult, UpdateStatus } from '@shared/contracts/update.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

/** The renderer's only door to the main-owned update service (window.posApi.updates). */
export class UpdatesService {
  constructor(private readonly gateway: Window['posApi']['updates'] = window.posApi.updates) {}

  async getStatus(): Promise<UpdateStatus> {
    return unwrapIpcResult(await this.gateway.getStatus())
  }

  async checkNow(): Promise<UpdateStatus> {
    return unwrapIpcResult(await this.gateway.checkNow())
  }

  async restartToInstall(): Promise<UpdateRestartResult> {
    return unwrapIpcResult(await this.gateway.restartToInstall())
  }

  onChanged(listener: (status: UpdateStatus) => void): () => void {
    return this.gateway.onChanged(listener)
  }
}
