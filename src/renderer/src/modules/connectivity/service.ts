import type { ConnectivitySnapshot } from '@shared/contracts/connectivity.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

export interface ConnectivityGateway {
  getState(): ReturnType<Window['posApi']['connectivity']['getState']>
  checkNow(): ReturnType<Window['posApi']['connectivity']['checkNow']>
  onChanged(listener: (snapshot: ConnectivitySnapshot) => void): () => void
}

export class ConnectivityGatewayService {
  constructor(private readonly gateway: ConnectivityGateway = window.posApi.connectivity) {}

  async getState(): Promise<ConnectivitySnapshot> {
    return unwrapIpcResult(await this.gateway.getState())
  }

  async checkNow(): Promise<ConnectivitySnapshot> {
    return unwrapIpcResult(await this.gateway.checkNow())
  }

  onChanged(listener: (snapshot: ConnectivitySnapshot) => void): () => void {
    return this.gateway.onChanged(listener)
  }
}
