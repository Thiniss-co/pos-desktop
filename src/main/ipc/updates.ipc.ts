import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  updateRestartResultSchema,
  updateStatusSchema,
  type UpdateStatus
} from '@shared/contracts/update.contract'
import {
  updatesCheckNowInputSchema,
  updatesGetStatusInputSchema,
  updatesRestartToInstallInputSchema
} from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleTrustedIpcRequest } from './handleIpcRequest'

export function broadcastUpdateStatus(status: UpdateStatus): void {
  const payload = updateStatusSchema.parse(status)

  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(IPC_CHANNELS.updatesChanged, payload)
    } catch {
      // A window tearing down must not stop delivery to the others.
    }
  }
}

export function registerUpdateIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.updatesGetStatus, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, updatesGetStatusInputSchema, () =>
      updateStatusSchema.parse(services.updates.status())
    )
  )
  ipcMain.handle(IPC_CHANNELS.updatesCheckNow, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, updatesCheckNowInputSchema, async () =>
      updateStatusSchema.parse(await services.updates.checkNow())
    )
  )
  ipcMain.handle(IPC_CHANNELS.updatesRestartToInstall, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, updatesRestartToInstallInputSchema, () =>
      updateRestartResultSchema.parse(services.updates.restartToInstall())
    )
  )
}
