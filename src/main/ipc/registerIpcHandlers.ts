import type { ApplicationServices } from '../app/applicationServices'
import { registerAuthIpcHandlers } from './auth.ipc'
import { registerBootstrapIpcHandlers } from './bootstrap.ipc'
import { registerDeviceIpcHandlers } from './device.ipc'
import { registerSyncIpcHandlers } from './sync.ipc'
import { registerSystemIpcHandlers } from './system.ipc'

let hasRegisteredIpcHandlers = false

export function registerIpcHandlers(services: ApplicationServices): void {
  if (hasRegisteredIpcHandlers) {
    return
  }

  registerSystemIpcHandlers(services)
  registerDeviceIpcHandlers(services)
  registerAuthIpcHandlers(services)
  registerBootstrapIpcHandlers(services)
  registerSyncIpcHandlers(services)

  hasRegisteredIpcHandlers = true
}
