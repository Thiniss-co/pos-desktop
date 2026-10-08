import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  authGetSessionSummaryInputSchema,
  authLoginInputSchema,
  authLogoutInputSchema,
  authRefreshSessionInputSchema
} from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleTrustedIpcRequest } from './handleIpcRequest'

export function registerAuthIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.authGetSessionSummary, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, authGetSessionSummaryInputSchema, () =>
      services.session.getSummary()
    )
  )

  ipcMain.handle(IPC_CHANNELS.authLogin, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, authLoginInputSchema, (value) =>
      services.auth.login(value)
    )
  )

  ipcMain.handle(IPC_CHANNELS.authRefreshSession, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, authRefreshSessionInputSchema, () =>
      services.auth.refreshSession()
    )
  )

  ipcMain.handle(IPC_CHANNELS.authLogout, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, authLogoutInputSchema, () => services.auth.logout())
  )
}
