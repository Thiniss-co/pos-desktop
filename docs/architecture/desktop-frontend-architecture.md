# Desktop Frontend Architecture

## Overview

`pos-desktop` is an Electron application with three isolated process contexts (main, preload,
renderer) around a Vue 3 SPA. It is designed to work fully offline against a local SQLite
database, syncing to the Laravel backend opportunistically. Full rule set:
[.ai/guidelines/desktop-architecture.md](../../.ai/guidelines/desktop-architecture.md).

## Process Diagram

```mermaid
flowchart TB
    subgraph Renderer["Renderer Process (Vue 3, no Node access)"]
        Pages["Pages / Views (thin)"]
        Stores["Pinia Stores"]
        Services["Services (API client, sync, print)"]
        Pages --> Stores --> Services
    end

    subgraph Preload["Preload (contextBridge boundary)"]
        PosApi["window.posApi (typed surface)"]
    end

    subgraph Main["Main Process (Node.js, full OS access)"]
        IPC["IPC Handlers (Zod-validated)"]
        Repos["Repositories"]
        SQLite[("SQLite")]
        Printer["Printing Bridge"]
        HTTP["Outbound HTTP (to Laravel backend)"]
        IPC --> Repos --> SQLite
        IPC --> Printer
        IPC --> HTTP
    end

    Services -->|"posApi.*(payload)"| PosApi
    PosApi -->|"ipcRenderer.invoke(channel)"| IPC

    Backend[("Laravel Backend\n/api/v1/desktop/*")]
    HTTP --> Backend
```

## Responsibilities

| Process | Owns | Never does |
|---|---|---|
| Main | SQLite, migrations, repositories, printing, device identity, secure token storage, outbound HTTP to backend | Render UI |
| Preload | Narrow typed bridge (`window.posApi`) | Business logic, SQL, HTTP calls itself |
| Renderer | UI, Pinia state, routing, presentation logic | Node access, SQLite, filesystem, raw IPC |

## Data Flow (Read)

```txt
Vue page -> Pinia store -> service -> window.posApi.X() -> IPC -> repository -> SQLite -> (reverse)
```

For data that may also come from the backend (e.g. bootstrap catalog refresh), the service layer
decides local-vs-remote based on connectivity/staleness — the page never knows the difference.

## Auth Flow (target — Phase 2)

```mermaid
sequenceDiagram
    participant U as Cashier
    participant R as Renderer (auth store)
    participant M as Main (auth service)
    participant B as Backend

    U->>R: Enter credentials
    R->>M: posApi.auth.login(payload)
    M->>B: POST /api/v1/desktop/auth/login
    B-->>M: envelope { success, data: { token, ... } }
    M->>M: Store token securely (main-process/OS store)
    M-->>R: { user, deviceBound: true } (no raw token)
    R->>R: Set authenticated state, route to app shell
```

Device registration (`POST /api/v1/desktop/device/register`) precedes login on a fresh install and
follows the same pattern — see
[backend-contract/auth-device-contract.md](../backend-contract/auth-device-contract.md).

## Bootstrap Flow (target — Phase 2)

```mermaid
sequenceDiagram
    participant R as Renderer (bootstrap store)
    participant M as Main
    participant B as Backend
    participant D as SQLite

    R->>M: posApi.bootstrap.get()
    M->>D: Read last persisted snapshot
    M-->>R: snapshot (immediate, works offline)
    M->>B: GET /api/v1/desktop/bootstrap (background, if online)
    B-->>M: fresh snapshot
    M->>D: Persist fresh snapshot
    M-->>R: posApi.bootstrap onUpdate (renderer refreshes if relevant)
```

## Sync Flow (target — Phase 4)

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> syncing
    syncing --> synced
    syncing --> failed: transient error
    failed --> pending: retry/backoff
    syncing --> conflict: IDEMPOTENCY_CONFLICT / data conflict
    conflict --> [*]: quarantined, needs resolution
    syncing --> paused: license/subscription denied
    paused --> pending: license resolved
```

Full state/ordering rules:
[offline-sync-architecture.md](offline-sync-architecture.md) and
[.ai/guidelines/offline-sync-contract.md](../../.ai/guidelines/offline-sync-contract.md).

## Current vs. Target

The diagrams above describe the **target** architecture. As of Phase 0, only the Electron
main/preload/renderer scaffold exists (`src/main/index.ts`, `src/preload/index.ts`,
`src/renderer/src/App.vue`) with no modules, stores, database, or API client yet. See
[../phases/01-foundation-structure.md](../phases/01-foundation-structure.md) for what Phase 1
actually builds.
