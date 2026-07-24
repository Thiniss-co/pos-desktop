import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  companyUsersCreateInputSchema,
  companyUsersGetAccessInputSchema,
  companyUsersGetInputSchema,
  companyUsersListAssignableRolesInputSchema,
  companyUsersListInputSchema,
  companyUsersSetEnabledInputSchema,
  companyUsersSetRolesInputSchema,
  companyUsersUpdateInputSchema
} from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleIpcRequest } from './handleIpcRequest'

export function registerCompanyUsersIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.companyUsersGetAccess, (_event, input: unknown) =>
    handleIpcRequest(input, companyUsersGetAccessInputSchema, () =>
      services.companyUsers.getAccess()
    )
  )

  ipcMain.handle(IPC_CHANNELS.companyUsersList, (_event, input: unknown) =>
    handleIpcRequest(input, companyUsersListInputSchema, (value) =>
      services.companyUsers.list(value)
    )
  )

  ipcMain.handle(IPC_CHANNELS.companyUsersGet, (_event, input: unknown) =>
    handleIpcRequest(input, companyUsersGetInputSchema, (value) =>
      services.companyUsers.get(value.uuid)
    )
  )

  ipcMain.handle(IPC_CHANNELS.companyUsersCreate, (_event, input: unknown) =>
    handleIpcRequest(input, companyUsersCreateInputSchema, (value) =>
      services.companyUsers.create(value)
    )
  )

  ipcMain.handle(IPC_CHANNELS.companyUsersUpdate, (_event, input: unknown) =>
    handleIpcRequest(input, companyUsersUpdateInputSchema, (value) =>
      services.companyUsers.update(value)
    )
  )

  ipcMain.handle(IPC_CHANNELS.companyUsersSetRoles, (_event, input: unknown) =>
    handleIpcRequest(input, companyUsersSetRolesInputSchema, (value) =>
      services.companyUsers.setRoles(value)
    )
  )

  ipcMain.handle(IPC_CHANNELS.companyUsersSetEnabled, (_event, input: unknown) =>
    handleIpcRequest(input, companyUsersSetEnabledInputSchema, (value) =>
      services.companyUsers.setEnabled(value)
    )
  )

  ipcMain.handle(IPC_CHANNELS.companyUsersListAssignableRoles, (_event, input: unknown) =>
    handleIpcRequest(input, companyUsersListAssignableRolesInputSchema, () =>
      services.companyUsers.listAssignableRoles()
    )
  )
}
