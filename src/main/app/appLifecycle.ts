import { app, BrowserWindow, dialog, Menu } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerIpcHandlers } from '../ipc/registerIpcHandlers'
import { createApplicationServices, type ApplicationServices } from './applicationServices'
import { createMainWindow } from './createMainWindow'
import { holdSingleInstance, pinPackagedUserData } from './instanceLocation'
import { startupFailureMessage } from './startupFailure'

export function bootstrapApp(): void {
  let services: ApplicationServices | null = null
  let mainWindow: BrowserWindow | null = null

  // Before anything opens userData (the SQLite database, safeStorage): a stable data folder, and one
  // till process per folder.
  pinPackagedUserData(app)
  const holdsInstance = holdSingleInstance(app, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  if (!holdsInstance) {
    return
  }

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app
    .whenReady()
    .then(() => {
      // Windows taskbar/notification identity: must equal electron-builder.yml `appId`
      // (verify:cp3g5-package checks it; both are still the template value, pending the real one).
      electronApp.setAppUserModelId('com.electron.app')

      // A packaged till has no default menu: its View menu offers Reload and Toggle Developer Tools
      // (Alt shows the auto-hidden bar). macOS keeps only the app and Edit menus, which carry the
      // clipboard shortcuts there.
      if (app.isPackaged) {
        Menu.setApplicationMenu(
          process.platform === 'darwin'
            ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
            : null
        )
      }

      // Default open or close DevTools by F12 in development
      // and ignore CommandOrControl + R in production.
      // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
      app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window)
      })

      services = createApplicationServices()

      registerIpcHandlers(services)
      services.connectivity.start()
      // Presence-only heartbeat. Sends nothing unless a cashier session is valid.
      services.deviceHeartbeat.start()
      // Rev 4 §7.3: proactive, bounded license renewal (and catalog install when the catalog is
      // missing or stale). Sends nothing without a signed-in owner.
      services.renewal.start()
      // Rev 4 §9.1: settle an attempt a previous run left claimed on a superseded catalog.
      services.attemptSettlement.settleSuperseded()
      // Rev 3: a restart discovers and re-sends every outstanding recorded allocation request.
      services.allocationDispatchReconciler.requestRun()

      // Drain anything left queued by a previous run. Deliberately after registerIpcHandlers, so a
      // reclaim or a pause is already observable by the time the renderer can ask for status. The
      // worker re-runs its own authorization gate, so starting it here grants it nothing.
      services.invoiceUploads.requestRun()
      // POS improvements, Stage 2: replay or send register quick-create requests left by a previous run.
      services.entityCreates.requestRun()

      // Connectivity is demand-driven: there is no polling loop. Regaining focus is the moment the
      // operator is about to act on backend-dependent state, so the verdict is refreshed then —
      // and only if it is already stale, so window churn costs nothing.
      app.on('browser-window-focus', () => {
        void services?.connectivity.ensureFresh()
      })

      mainWindow = createMainWindow()
      // Background update checks start after the window exists (status goes to Settings).
      services.updates.start()

      app.on('activate', function () {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
      })
    })
    .catch((error: unknown) => {
      console.error('Application initialization failed', error)
      // Never a silent quit: the cashier sees why, and that the data must be kept.
      const message = startupFailureMessage(error, app.getPath('userData'))
      dialog.showErrorBox(message.title, message.body)
      app.quit()
    })

  // Quit when all windows are closed, except on macOS. There, it's common
  // for applications and their menu bar to stay active until the user quits
  // explicitly with Cmd + Q.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    services?.shutdown()
    services = null
  })
}
