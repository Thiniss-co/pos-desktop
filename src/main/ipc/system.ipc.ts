import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { systemGetRuntimeInfoInputSchema } from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleIpcRequest } from './handleIpcRequest'

export function registerSystemIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.systemGetRuntimeInfo, (_event, input: unknown) =>
    handleIpcRequest(input, systemGetRuntimeInfoInputSchema, () => services.getRuntimeInfo())
  )
}
