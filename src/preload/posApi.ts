import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import type { ActivationInput, ActivationResult } from '@shared/contracts/activation.contract'
import type { LoginInput, SessionSummary } from '@shared/contracts/auth.contract'
import type { BootstrapResult, BootstrapStatus } from '@shared/contracts/bootstrap.contract'
import type { DeviceIdentitySummary } from '@shared/contracts/device.contract'
import type { IpcResult } from '@shared/contracts/ipc.contract'
import type { LicenseStatus } from '@shared/contracts/license.contract'
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
  }
  readonly bootstrap: {
    getStatus(): Promise<IpcResult<BootstrapStatus>>
    refresh(): Promise<IpcResult<BootstrapResult>>
  }
  readonly sync: {
    getStatus(): Promise<IpcResult<SyncStatus>>
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
    validate: () => ipcRenderer.invoke(IPC_CHANNELS.licenseValidate)
  }),
  bootstrap: Object.freeze({
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrapGetStatus),
    refresh: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrapRefresh)
  }),
  sync: Object.freeze({
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.syncGetStatus)
  })
})
