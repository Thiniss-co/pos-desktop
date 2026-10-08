import type { BrowserWindow } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'

/** The packaged renderer page: the only `file:` page the main window may show or invoke IPC from. */
export function rendererIndexUrl(): URL {
  return pathToFileURL(join(__dirname, '../renderer/index.html'))
}

function samePath(left: string, right: string): boolean {
  // Windows file URLs may differ only in drive-letter case.
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export function getDevelopmentRendererUrl(): URL | undefined {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']

  // Only an `electron-vite dev` build (the only one that sets ELECTRON_RENDERER_URL) may load the
  // development server. A production build never does, packaged or not. This deliberately avoids
  // importing Electron, so every module that checks a sender stays loadable outside the app.
  if (import.meta.env?.DEV !== true || !rendererUrl) {
    return undefined
  }

  try {
    return new URL(rendererUrl)
  } catch {
    throw new Error(`Invalid ELECTRON_RENDERER_URL: ${rendererUrl}`)
  }
}

export function isAllowedNavigation(
  url: string,
  developmentRendererUrl: URL | undefined,
  indexUrl: URL = rendererIndexUrl()
): boolean {
  try {
    const target = new URL(url)

    if (developmentRendererUrl) {
      return target.origin === developmentRendererUrl.origin
    }

    // The app's own page only (any hash route of it), never another local file.
    return target.protocol === 'file:' && samePath(target.pathname, indexUrl.pathname)
  } catch {
    return false
  }
}

function createContentSecurityPolicy(developmentRendererUrl: URL | undefined): string {
  if (developmentRendererUrl) {
    if (
      developmentRendererUrl.protocol !== 'http:' &&
      developmentRendererUrl.protocol !== 'https:'
    ) {
      throw new Error('ELECTRON_RENDERER_URL must use the http: or https: protocol')
    }

    const developmentWebSocketUrl = new URL(developmentRendererUrl.origin)
    developmentWebSocketUrl.protocol = developmentRendererUrl.protocol === 'http:' ? 'ws:' : 'wss:'

    return `default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ${developmentRendererUrl.origin} ${developmentWebSocketUrl.origin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`
  }

  return "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
}

export function applyWindowSecurityPolicy(window: BrowserWindow): void {
  const developmentRendererUrl = getDevelopmentRendererUrl()
  const contentSecurityPolicy = createContentSecurityPolicy(developmentRendererUrl)

  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, developmentRendererUrl)) {
      event.preventDefault()
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const { session } = window.webContents
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy]
      }
    })
  })
}
