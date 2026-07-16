import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { bootstrapGetStatusInputSchema } from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleIpcRequest } from './handleIpcRequest'

export function registerBootstrapIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.bootstrapGetStatus, (_event, input: unknown) =>
    handleIpcRequest(input, bootstrapGetStatusInputSchema, () =>
      services.bootstrapState.getStatus()
    )
  )
}
