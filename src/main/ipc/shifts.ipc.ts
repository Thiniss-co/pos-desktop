import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  shiftsCloseInputSchema,
  shiftsCurrentInputSchema,
  shiftsGetInputSchema,
  shiftsOpenInputSchema,
  shiftsPauseInputSchema,
  shiftsResumeInputSchema
} from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleIpcRequest } from './handleIpcRequest'

export function registerShiftIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.shiftsCurrent, (_event, input: unknown) =>
    handleIpcRequest(input, shiftsCurrentInputSchema, () => services.shifts.current())
  )
  ipcMain.handle(IPC_CHANNELS.shiftsGet, (_event, input: unknown) =>
    handleIpcRequest(input, shiftsGetInputSchema, (value) => services.shifts.get(value.uuid))
  )
  ipcMain.handle(IPC_CHANNELS.shiftsOpen, (_event, input: unknown) =>
    handleIpcRequest(input, shiftsOpenInputSchema, (value) => services.shifts.open(value))
  )
  ipcMain.handle(IPC_CHANNELS.shiftsPause, (_event, input: unknown) =>
    handleIpcRequest(input, shiftsPauseInputSchema, (value) => services.shifts.pause(value))
  )
  ipcMain.handle(IPC_CHANNELS.shiftsResume, (_event, input: unknown) =>
    handleIpcRequest(input, shiftsResumeInputSchema, (value) => services.shifts.resume(value))
  )
  ipcMain.handle(IPC_CHANNELS.shiftsClose, (_event, input: unknown) =>
    handleIpcRequest(input, shiftsCloseInputSchema, (value) => services.shifts.close(value))
  )
}
