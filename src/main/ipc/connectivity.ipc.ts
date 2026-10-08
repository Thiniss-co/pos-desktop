import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  connectivitySnapshotSchema,
  type ConnectivitySnapshot
} from '@shared/contracts/connectivity.contract'
import {
  connectivityCheckNowInputSchema,
  connectivityGetStateInputSchema
} from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleTrustedIpcRequest } from './handleIpcRequest'

export function broadcastConnectivityChanged(snapshot: ConnectivitySnapshot): void {
  const payload = connectivitySnapshotSchema.parse(snapshot)

  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }

    try {
      window.webContents.send(IPC_CHANNELS.connectivityChanged, payload)
    } catch {
      // One window's send failing (e.g. a race with its own teardown) must not stop delivery to
      // the remaining windows.
    }
  }
}

export function registerConnectivityIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.connectivityGetState, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, connectivityGetStateInputSchema, () =>
      connectivitySnapshotSchema.parse(services.connectivity.getSnapshot())
    )
  )
  ipcMain.handle(IPC_CHANNELS.connectivityCheckNow, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, connectivityCheckNowInputSchema, async () =>
      connectivitySnapshotSchema.parse(await services.connectivity.checkNow())
    )
  )
}
