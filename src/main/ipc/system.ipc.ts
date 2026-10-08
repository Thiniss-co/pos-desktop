import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { systemGetRuntimeInfoInputSchema } from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleTrustedIpcRequest } from './handleIpcRequest'

export function registerSystemIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.systemGetRuntimeInfo, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, systemGetRuntimeInfoInputSchema, () =>
      services.getRuntimeInfo()
    )
  )
}
