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
import { handleTrustedIpcRequest } from './handleIpcRequest'

export function registerCompanyUsersIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.companyUsersGetAccess, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, companyUsersGetAccessInputSchema, () =>
      services.companyUsers.getAccess()
    )
  )

  ipcMain.handle(IPC_CHANNELS.companyUsersList, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, companyUsersListInputSchema, (value) =>
      services.companyUsers.list(value)
    )
  )

  ipcMain.handle(IPC_CHANNELS.companyUsersGet, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, companyUsersGetInputSchema, (value) =>
      services.companyUsers.get(value.uuid)
    )
  )

  ipcMain.handle(IPC_CHANNELS.companyUsersCreate, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, companyUsersCreateInputSchema, (value) =>
      services.companyUsers.create(value)
    )
  )

  ipcMain.handle(IPC_CHANNELS.companyUsersUpdate, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, companyUsersUpdateInputSchema, (value) =>
      services.companyUsers.update(value)
    )
  )

  ipcMain.handle(IPC_CHANNELS.companyUsersSetRoles, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, companyUsersSetRolesInputSchema, (value) =>
      services.companyUsers.setRoles(value)
    )
  )

  ipcMain.handle(IPC_CHANNELS.companyUsersSetEnabled, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, companyUsersSetEnabledInputSchema, (value) =>
      services.companyUsers.setEnabled(value)
    )
  )

  ipcMain.handle(IPC_CHANNELS.companyUsersListAssignableRoles, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, companyUsersListAssignableRolesInputSchema, () =>
      services.companyUsers.listAssignableRoles()
    )
  )
}
