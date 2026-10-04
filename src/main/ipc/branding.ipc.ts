import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { brandingGetInputSchema } from '@shared/validators/ipc.validators'
import { ipcFailure } from '@shared/contracts/ipc.contract'
import type { ApplicationServices } from '../app/applicationServices'
import { isPublicAppError } from '../http/apiError'
import { assertTrustedSender } from './assertTrustedSender'
import { handleIpcRequest } from './handleIpcRequest'

const unexpectedError = {
  category: 'unexpected',
  message: 'The request could not be completed',
  retryable: false
} as const

/**
 * Owner UX plan P9 — tells every live renderer that the company identity may have changed (a
 * persisted bootstrap, a stored logo). It carries nothing: the renderer re-reads through `branding:get`.
 */
export function broadcastBrandingChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(IPC_CHANNELS.brandingChanged)
    } catch {
      // A teardown race in one renderer must not stop delivery to the others.
    }
  }
}

export function registerBrandingIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.brandingGet, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }
    return handleIpcRequest(input, brandingGetInputSchema, () => services.branding.current())
  })
}
