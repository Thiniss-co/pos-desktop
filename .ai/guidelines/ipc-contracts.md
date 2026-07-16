# IPC Contract Rules

## Preload Exposes `window.posApi`

The single renderer-facing surface is `window.posApi`, assembled in `src/preload/index.ts` via
`contextBridge.exposeInMainWorld('posApi', posApi)`. It replaced the template's blanket
`window.electron` (`electronAPI`) exposure — see `electron-security.md` for why. The surface grows
only through named capabilities in later phases:

```ts
interface PosApi {
  auth: {
    login(payload: LoginRequest): Promise<LoginResult>
    logout(): Promise<void>
  }
  bootstrap: {
    get(): Promise<BootstrapSnapshot>
    refresh(): Promise<BootstrapSnapshot>
  }
  sales: {
    queue(payload: QueueSalePayload): Promise<QueuedSale>
  }
  sync: {
    getStatus(): Promise<SyncStatus>
    onStatusChange(cb: (status: SyncStatus) => void): () => void
  }
  print: {
    receipt(payload: ReceiptPayload): Promise<PrintResult>
  }
  device: {
    getInfo(): Promise<DeviceInfo>
  }
}
```

Each namespace maps 1:1 to a domain/module. Adding a capability means adding a named method here
and its matching handler in main — never a generic `invoke(channel, ...args)` passthrough.

## All IPC Channels Typed

- Channel names are constants (e.g. `IPC.AUTH_LOGIN = 'auth:login'`), defined once and shared
  between main and preload (a small shared types/constants module importable from both, without
  pulling in Node or DOM-only globals).
- Each channel has exactly one request type and one response type.

## All Payloads Validated

- Every `ipcMain.handle(channel, ...)` validates the incoming payload with a Zod schema before
  doing anything with it. A validation failure returns a typed error result — it does not throw an
  uncaught exception across the IPC boundary.

## Main Returns Typed Results

- Handlers return `{ ok: true, data: T } | { ok: false, code: string, message: string }` (or
  equivalent discriminated union) — not raw driver errors, not backend envelope objects verbatim
  when they contain internal detail that shouldn't reach the renderer unfiltered.
- The renderer-side `posApi` wrapper unwraps this into a `Promise` that resolves with `T` or
  rejects with a sanitized error the UI can display.

## Renderer Never Gets Raw Errors/Secrets

- Stack traces, file paths, SQL text, and internal exception messages are logged in main (or
  written to a local log file) and reduced to a safe `{ code, message }` before crossing to the
  renderer.
- Tokens, device secrets, and printer/OS handles are never included in an IPC response payload
  beyond what the specific capability needs (e.g. `auth.login` may resolve with a user/session
  summary, not the raw stored token).

## Do Not Expose a Generic Invoke Channel

No `window.posApi.invoke(channel: string, ...args: unknown[])`-style escape hatch. If a new
capability is needed, add it explicitly to the `PosApi` interface and its handler — this keeps the
attack surface enumerable and reviewable.

## Current State (evidence)

The foundation exposes exactly five named read capabilities: runtime info, device identity summary,
session summary, bootstrap status, and sync status. Each has a shared channel constant, an
`ipcMain.handle` handler with a Zod input schema, and a structured-clone-safe `IpcResult` response.
The template `ping` handler and generic `window.electron` bridge are removed.
