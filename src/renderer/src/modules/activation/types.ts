import type { DeviceIdentitySummary } from '@shared/contracts/device.contract'

export type DeviceDisplayState = DeviceIdentitySummary | null

export interface ActivationFormState {
  companyCode: string
  activationCode: string
  deviceName: string
}
