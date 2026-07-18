import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  authGetSessionSummaryInputSchema,
  authLoginInputSchema,
  authLogoutInputSchema,
  authRefreshSessionInputSchema
} from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleIpcRequest } from './handleIpcRequest'

export function registerAuthIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.authGetSessionSummary, (_event, input: unknown) =>
    handleIpcRequest(input, authGetSessionSummaryInputSchema, () => services.session.getSummary())
  )

  ipcMain.handle(IPC_CHANNELS.authLogin, (_event, input: unknown) =>
    handleIpcRequest(input, authLoginInputSchema, (value) => services.auth.login(value))
  )

  ipcMain.handle(IPC_CHANNELS.authRefreshSession, (_event, input: unknown) =>
    handleIpcRequest(input, authRefreshSessionInputSchema, () => services.auth.refreshSession())
  )

  ipcMain.handle(IPC_CHANNELS.authLogout, (_event, input: unknown) =>
    handleIpcRequest(input, authLogoutInputSchema, () => services.auth.logout())
  )
}
