import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { syncGetStatusInputSchema } from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleIpcRequest } from './handleIpcRequest'

export function registerSyncIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.syncGetStatus, (_event, input: unknown) =>
    // The worker's view, not the repository's: only the worker knows whether it is paused, and a
    // status that always claimed 'idle' would leave a licence-blocked queue looking healthy.
    handleIpcRequest(input, syncGetStatusInputSchema, () => services.invoiceUploads.getStatus())
  )
}
