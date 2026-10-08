import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  shiftsCloseInputSchema,
  shiftsCurrentInputSchema,
  shiftsGetInputSchema,
  shiftsLocalAuthorityInputSchema,
  shiftsOpenInputSchema,
  shiftsPauseInputSchema,
  shiftsResumeInputSchema
} from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleTrustedIpcRequest } from './handleIpcRequest'

export function registerShiftIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.shiftsCurrent, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, shiftsCurrentInputSchema, () => services.shifts.current())
  )
  ipcMain.handle(IPC_CHANNELS.shiftsLocalAuthority, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, shiftsLocalAuthorityInputSchema, () =>
      services.shifts.localAuthority()
    )
  )
  ipcMain.handle(IPC_CHANNELS.shiftsGet, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, shiftsGetInputSchema, (value) =>
      services.shifts.get(value.uuid)
    )
  )
  ipcMain.handle(IPC_CHANNELS.shiftsOpen, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, shiftsOpenInputSchema, (value) =>
      services.shifts.open(value)
    )
  )
  ipcMain.handle(IPC_CHANNELS.shiftsPause, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, shiftsPauseInputSchema, (value) =>
      services.shifts.pause(value)
    )
  )
  ipcMain.handle(IPC_CHANNELS.shiftsResume, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, shiftsResumeInputSchema, (value) =>
      services.shifts.resume(value)
    )
  )
  ipcMain.handle(IPC_CHANNELS.shiftsClose, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, shiftsCloseInputSchema, (value) =>
      services.shifts.close(value)
    )
  )
}
