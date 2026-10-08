import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { deviceIdentitySummarySchema } from '@shared/contracts/device.contract'
import {
  deviceGetIdentitySummaryInputSchema,
  deviceRegisterInputSchema
} from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleTrustedIpcRequest } from './handleIpcRequest'

export function registerDeviceIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.deviceGetIdentitySummary, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, deviceGetIdentitySummaryInputSchema, () =>
      deviceIdentitySummarySchema.parse({
        ...services.deviceIdentity.getOrCreate(),
        registrationStatus: services.deviceRegistration.get()?.status ?? null
      })
    )
  )

  ipcMain.handle(IPC_CHANNELS.deviceRegister, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, deviceRegisterInputSchema, (value) =>
      services.activation.register(value)
    )
  )
}
