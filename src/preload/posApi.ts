import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import type { ActivationInput, ActivationResult } from '@shared/contracts/activation.contract'
import type { LoginInput, SessionSummary } from '@shared/contracts/auth.contract'
import type { BootstrapResult, BootstrapStatus } from '@shared/contracts/bootstrap.contract'
import type {
  AssignableRoles,
  CompanyUser,
  CompanyUserAccess,
  CompanyUserList,
  CreateCompanyUserInput,
  ListUsersInput,
  SetEnabledInput,
  SetRolesInput,
  UpdateCompanyUserInput
} from '@shared/contracts/company-users.contract'
import type { DeviceIdentitySummary } from '@shared/contracts/device.contract'
import type { IpcResult } from '@shared/contracts/ipc.contract'
import type { CommercialAccessSnapshot, LicenseStatus } from '@shared/contracts/license.contract'
import type { SyncStatus } from '@shared/contracts/sync.contract'
import type { RuntimeInfo } from '@shared/contracts/system.contract'

export interface PosApi {
  readonly system: {
    getRuntimeInfo(): Promise<IpcResult<RuntimeInfo>>
  }
  readonly device: {
    getIdentitySummary(): Promise<IpcResult<DeviceIdentitySummary>>
    register(input: ActivationInput): Promise<IpcResult<ActivationResult>>
  }
  readonly auth: {
    getSessionSummary(): Promise<IpcResult<SessionSummary>>
    login(input: LoginInput): Promise<IpcResult<SessionSummary>>
    refreshSession(): Promise<IpcResult<SessionSummary>>
    logout(): Promise<IpcResult<void>>
  }
  readonly license: {
    validate(): Promise<IpcResult<LicenseStatus>>
    getAccess(): Promise<IpcResult<CommercialAccessSnapshot>>
  }
  readonly bootstrap: {
    getStatus(): Promise<IpcResult<BootstrapStatus>>
    refresh(): Promise<IpcResult<BootstrapResult>>
  }
  readonly sync: {
    getStatus(): Promise<IpcResult<SyncStatus>>
  }
  readonly companyUsers: {
    getAccess(): Promise<IpcResult<CompanyUserAccess>>
    list(input: ListUsersInput): Promise<IpcResult<CompanyUserList>>
    get(input: { uuid: string }): Promise<IpcResult<CompanyUser>>
    create(input: CreateCompanyUserInput): Promise<IpcResult<CompanyUser>>
    update(input: UpdateCompanyUserInput): Promise<IpcResult<CompanyUser>>
    setRoles(input: SetRolesInput): Promise<IpcResult<CompanyUser>>
    setEnabled(input: SetEnabledInput): Promise<IpcResult<CompanyUser>>
    listAssignableRoles(): Promise<IpcResult<AssignableRoles>>
  }
}

export const posApi: PosApi = Object.freeze({
  system: Object.freeze({
    getRuntimeInfo: () => ipcRenderer.invoke(IPC_CHANNELS.systemGetRuntimeInfo)
  }),
  device: Object.freeze({
    getIdentitySummary: () => ipcRenderer.invoke(IPC_CHANNELS.deviceGetIdentitySummary),
    register: (input: ActivationInput) => ipcRenderer.invoke(IPC_CHANNELS.deviceRegister, input)
  }),
  auth: Object.freeze({
    getSessionSummary: () => ipcRenderer.invoke(IPC_CHANNELS.authGetSessionSummary),
    login: (input: LoginInput) => ipcRenderer.invoke(IPC_CHANNELS.authLogin, input),
    refreshSession: () => ipcRenderer.invoke(IPC_CHANNELS.authRefreshSession),
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.authLogout)
  }),
  license: Object.freeze({
    validate: () => ipcRenderer.invoke(IPC_CHANNELS.licenseValidate),
    getAccess: () => ipcRenderer.invoke(IPC_CHANNELS.licenseGetAccess)
  }),
  bootstrap: Object.freeze({
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrapGetStatus),
    refresh: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrapRefresh)
  }),
  sync: Object.freeze({
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.syncGetStatus)
  }),
  companyUsers: Object.freeze({
    getAccess: () => ipcRenderer.invoke(IPC_CHANNELS.companyUsersGetAccess),
    list: (input: ListUsersInput) => ipcRenderer.invoke(IPC_CHANNELS.companyUsersList, input),
    get: (input: { uuid: string }) => ipcRenderer.invoke(IPC_CHANNELS.companyUsersGet, input),
    create: (input: CreateCompanyUserInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.companyUsersCreate, input),
    update: (input: UpdateCompanyUserInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.companyUsersUpdate, input),
    setRoles: (input: SetRolesInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.companyUsersSetRoles, input),
    setEnabled: (input: SetEnabledInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.companyUsersSetEnabled, input),
    listAssignableRoles: () => ipcRenderer.invoke(IPC_CHANNELS.companyUsersListAssignableRoles)
  })
})
