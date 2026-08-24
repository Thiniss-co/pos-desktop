import type { CommercialAccessSnapshot } from '@shared/contracts/license.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

export class LicenseService {
  constructor(private readonly gateway: Window['posApi']['license'] = window.posApi.license) {}

  async validate(): Promise<CommercialAccessSnapshot> {
    return unwrapIpcResult(await this.gateway.validate())
  }

  async getAccess(): Promise<CommercialAccessSnapshot> {
    return unwrapIpcResult(await this.gateway.getAccess())
  }

  onAccessChanged(listener: (snapshot: CommercialAccessSnapshot) => void): () => void {
    return this.gateway.onAccessChanged(listener)
  }
}
