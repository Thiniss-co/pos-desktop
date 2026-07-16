import type { BootstrapStatus } from '@shared/contracts/bootstrap.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

export class BootstrapService {
  constructor(private readonly gateway: Window['posApi']['bootstrap'] = window.posApi.bootstrap) {}

  async getStatus(): Promise<BootstrapStatus> {
    return unwrapIpcResult(await this.gateway.getStatus())
  }
}
