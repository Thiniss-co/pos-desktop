import type { ActivationInput, ActivationResult } from '@shared/contracts/activation.contract'
import type { DeviceIdentitySummary } from '@shared/contracts/device.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

export class DeviceService {
  constructor(private readonly gateway: Window['posApi']['device'] = window.posApi.device) {}

  async getIdentitySummary(): Promise<DeviceIdentitySummary> {
    return unwrapIpcResult(await this.gateway.getIdentitySummary())
  }

  async register(input: ActivationInput): Promise<ActivationResult> {
    return unwrapIpcResult(await this.gateway.register(input))
  }
}
