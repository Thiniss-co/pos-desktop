import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { licenseValidateInputSchema } from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleIpcRequest } from './handleIpcRequest'

export function registerLicenseIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.licenseValidate, (_event, input: unknown) =>
    handleIpcRequest(input, licenseValidateInputSchema, () => services.license.validate())
  )
}
