import { join } from 'path'

/**
 * Where a packaged till keeps its data, independent of its display name.
 *
 * Electron derives the packaged userData folder from the product name. The product is displayed as
 * "Thinis POS", but every earlier package stored its database under `pos-desktop`; pinning the folder
 * keeps an upgrade (or a later display-name change) from starting with an empty database next to the
 * real one. Development and harness runs (not packaged) keep Electron's default.
 */
export const PACKAGED_USER_DATA_DIRECTORY = 'pos-desktop'

export interface InstanceApp {
  readonly isPackaged: boolean
  getPath(name: 'appData' | 'userData'): string
  setPath(name: 'userData', path: string): void
  requestSingleInstanceLock(): boolean
  quit(): void
  on(event: 'second-instance', listener: () => void): unknown
}

/** Must run before `app.whenReady()`: nothing may have opened userData yet. */
export function pinPackagedUserData(app: InstanceApp): string {
  if (app.isPackaged) {
    app.setPath('userData', join(app.getPath('appData'), PACKAGED_USER_DATA_DIRECTORY))
  }

  return app.getPath('userData')
}

/**
 * One till process per userData folder: a second launch (a double-clicked shortcut, an installer's
 * "run after finish" while the till is open) must not open the same SQLite database. The second
 * process quits at once; the first brings its window forward.
 */
export function holdSingleInstance(app: InstanceApp, focusExisting: () => void): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }

  app.on('second-instance', focusExisting)
  return true
}
