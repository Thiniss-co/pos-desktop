import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { authGetSessionSummaryInputSchema } from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleIpcRequest } from './handleIpcRequest'

export function registerAuthIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.authGetSessionSummary, (_event, input: unknown) =>
    handleIpcRequest(input, authGetSessionSummaryInputSchema, () => services.session.getSummary())
  )
}
