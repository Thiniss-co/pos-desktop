import type { ApplicationServices } from '../app/applicationServices'
import { registerAuthIpcHandlers } from './auth.ipc'
import { registerBootstrapIpcHandlers } from './bootstrap.ipc'
import { registerCatalogIpcHandlers } from './catalog.ipc'
import { registerCompanyUsersIpcHandlers } from './company-users.ipc'
import { registerDeviceIpcHandlers } from './device.ipc'
import { registerLicenseIpcHandlers } from './license.ipc'
import { registerShiftIpcHandlers } from './shifts.ipc'
import { registerConnectivityIpcHandlers } from './connectivity.ipc'
import { registerPreferencesIpcHandlers } from './preferences.ipc'
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
  registerLicenseIpcHandlers(services)
  registerBootstrapIpcHandlers(services)
  registerCatalogIpcHandlers(services)
  registerShiftIpcHandlers(services)
  registerCompanyUsersIpcHandlers(services)
  registerSyncIpcHandlers(services)
  registerConnectivityIpcHandlers(services)
  registerPreferencesIpcHandlers(services)

  hasRegisteredIpcHandlers = true
}
