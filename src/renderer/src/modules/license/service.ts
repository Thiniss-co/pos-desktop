import type { LicenseStatus } from '@shared/contracts/license.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

export class LicenseService {
  constructor(private readonly gateway: Window['posApi']['license'] = window.posApi.license) {}

  async validate(): Promise<LicenseStatus> {
    return unwrapIpcResult(await this.gateway.validate())
  }
}
