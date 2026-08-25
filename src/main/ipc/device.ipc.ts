import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { deviceIdentitySummarySchema } from '@shared/contracts/device.contract'
import {
  deviceGetIdentitySummaryInputSchema,
  deviceRegisterInputSchema
} from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleIpcRequest } from './handleIpcRequest'

export function registerDeviceIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.deviceGetIdentitySummary, (_event, input: unknown) =>
    handleIpcRequest(input, deviceGetIdentitySummaryInputSchema, () =>
      deviceIdentitySummarySchema.parse({
        ...services.deviceIdentity.getOrCreate(),
        registrationStatus: services.deviceRegistration.get()?.status ?? null
      })
    )
  )

  ipcMain.handle(IPC_CHANNELS.deviceRegister, (_event, input: unknown) =>
    handleIpcRequest(input, deviceRegisterInputSchema, (value) =>
      services.activation.register(value)
    )
  )
}
