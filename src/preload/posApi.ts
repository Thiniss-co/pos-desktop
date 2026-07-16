import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import type { SessionSummary } from '@shared/contracts/auth.contract'
import type { BootstrapStatus } from '@shared/contracts/bootstrap.contract'
import type { DeviceIdentitySummary } from '@shared/contracts/device.contract'
import type { IpcResult } from '@shared/contracts/ipc.contract'
import type { SyncStatus } from '@shared/contracts/sync.contract'
import type { RuntimeInfo } from '@shared/contracts/system.contract'

export interface PosApi {
  readonly system: {
    getRuntimeInfo(): Promise<IpcResult<RuntimeInfo>>
  }
  readonly device: {
    getIdentitySummary(): Promise<IpcResult<DeviceIdentitySummary>>
  }
  readonly auth: {
    getSessionSummary(): Promise<IpcResult<SessionSummary>>
  }
  readonly bootstrap: {
    getStatus(): Promise<IpcResult<BootstrapStatus>>
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
    getIdentitySummary: () => ipcRenderer.invoke(IPC_CHANNELS.deviceGetIdentitySummary)
  }),
  auth: Object.freeze({
    getSessionSummary: () => ipcRenderer.invoke(IPC_CHANNELS.authGetSessionSummary)
  }),
  bootstrap: Object.freeze({
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrapGetStatus)
  }),
  sync: Object.freeze({
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.syncGetStatus)
  })
})
