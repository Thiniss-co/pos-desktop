import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { syncGetStatusInputSchema } from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleIpcRequest } from './handleIpcRequest'

export function registerSyncIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.syncGetStatus, (_event, input: unknown) =>
    handleIpcRequest(input, syncGetStatusInputSchema, () => services.syncQueue.getStatus())
  )
}
