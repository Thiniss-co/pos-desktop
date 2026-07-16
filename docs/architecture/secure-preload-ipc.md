# Secure Preload / IPC

Rules: [.ai/guidelines/electron-security.md](../../.ai/guidelines/electron-security.md),
[.ai/guidelines/ipc-contracts.md](../../.ai/guidelines/ipc-contracts.md). This doc records the
implemented foundation shape and the pattern for later additions.

## Current State (evidence)

`window.posApi` is an immutable, typed bridge with exactly five foundation read methods:

- `system.getRuntimeInfo()`
- `device.getIdentitySummary()`
- `auth.getSessionSummary()`
- `bootstrap.getStatus()`
- `sync.getStatus()`

Each method invokes a fixed shared channel constant. The renderer receives structured-clone-safe
`IpcResult` data only; no tokens, filesystem paths, SQL, Node handles, callbacks, or caller-chosen
channels cross the boundary. The template `electronAPI`, `window.electron`, `window.api`, and
`ping` handler are removed.

## Foundation Shape

Preload exposes exactly one object, `window.posApi`:

```ts
// src/preload/posApi.ts
const posApi = Object.freeze({
  system: Object.freeze({
    getRuntimeInfo: () => ipcRenderer.invoke(IPC_CHANNELS.systemGetRuntimeInfo)
  }),
  // device, auth, bootstrap, and sync use the same fixed-channel pattern
})

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('posApi', posApi)
}
```

Each `ipcRenderer.invoke(channel, payload)` call is wrapped by a named method — the renderer never
calls `ipcRenderer.invoke` with a dynamic/arbitrary channel string.

## Main-Side Handler Shape

```ts
ipcMain.handle(IPC_CHANNELS.systemGetRuntimeInfo, (_event, input) => {
  return handleIpcRequest(input, systemGetRuntimeInfoInputSchema, () => services.getRuntimeInfo())
})
```

Zod validates input; errors are normalized to `IpcResult` before crossing back to the renderer — no
stack traces, raw driver errors, paths, or secrets.

## `webPreferences`

```ts
webPreferences: {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false
}
```

## Extension Rule

Later capabilities add one shared contract, one Zod-validated main handler, and one named preload
method. They never reintroduce a generic renderer-selected channel.
