# Secure Preload / IPC

Rules: [.ai/guidelines/electron-security.md](../../.ai/guidelines/electron-security.md),
[.ai/guidelines/ipc-contracts.md](../../.ai/guidelines/ipc-contracts.md). This doc explains the
current state and the target shape.

## Current State (evidence)

[src/preload/index.ts](../../src/preload/index.ts):

```ts
import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
}
```

`electronAPI` (from `@electron-toolkit/preload`) bundles `ipcRenderer` with generic
`invoke`/`send`/`on` methods, exposed wholesale as `window.electron`. This is standard
`electron-vite` template boilerplate and is **not** a security incident by itself (no handlers
exist yet beyond the template's `ipcMain.on('ping', ...)`), but it must not be extended — any real
capability added on top of this generic surface would let renderer code invoke arbitrary main-side
channels.

`src/main/index.ts:16` sets `webPreferences.sandbox: false` explicitly (also template default).

## Target Shape

Preload exposes exactly one object, `window.posApi`, replacing the blanket `window.electron`
exposure:

```ts
// src/preload/index.ts (target)
import { contextBridge, ipcRenderer } from 'electron'
import type { PosApi } from '../shared/ipc/contract'
import { IPC_CHANNELS } from '../shared/ipc/channels'

const posApi: PosApi = {
  auth: {
    login: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGIN, payload),
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGOUT)
  },
  // ...bootstrap, sales, sync, print, device
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('posApi', posApi)
} else {
  throw new Error('contextIsolation must be enabled')
}
```

Each `ipcRenderer.invoke(channel, payload)` call is wrapped by a named method — the renderer never
calls `ipcRenderer.invoke` with a dynamic/arbitrary channel string.

## Main-Side Handler Shape (target)

```ts
// src/main/ipc/auth.ts (target)
ipcMain.handle(IPC_CHANNELS.AUTH_LOGIN, async (_event, rawPayload) => {
  const parsed = loginRequestSchema.safeParse(rawPayload)
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION_FAILED', message: 'Invalid login payload' }
  }
  try {
    const result = await authService.login(parsed.data)
    return { ok: true, data: result }
  } catch (err) {
    return { ok: false, code: toErrorCode(err), message: toSafeMessage(err) }
  }
})
```

Zod validates input; errors are normalized to `{ ok: false, code, message }` before crossing back
to the renderer — no stack traces, no raw driver errors, no secrets.

## `webPreferences` Target

```ts
webPreferences: {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true // flip from current `false`; document any dependency that requires false
}
```

## Migration Note

Moving from the current state to the target is Phase 1 scope. It is a breaking change to
`window.electron`/`window.api` consumers — since no renderer code references them yet beyond the
unused template `Versions.vue` component, this is low-risk to do early rather than after UI code
accumulates dependencies on the generic surface.
