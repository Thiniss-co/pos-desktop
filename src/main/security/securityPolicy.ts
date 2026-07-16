import { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'

function getDevelopmentRendererUrl(): URL | undefined {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']

  if (!is.dev || !rendererUrl) {
    return undefined
  }

  try {
    return new URL(rendererUrl)
  } catch {
    throw new Error(`Invalid ELECTRON_RENDERER_URL: ${rendererUrl}`)
  }
}

function isAllowedNavigation(url: string, developmentRendererUrl: URL | undefined): boolean {
  try {
    const target = new URL(url)

    if (developmentRendererUrl) {
      return target.origin === developmentRendererUrl.origin
    }

    return target.protocol === 'file:'
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
