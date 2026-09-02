import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  SYNC_FAILURE_PAGE_DEFAULT_SIZE,
  syncFailurePageSchema,
  syncStatusSchema,
  type SyncStatus
} from '@shared/contracts/sync.contract'
import {
  syncGetStatusInputSchema,
  syncListFailuresInputSchema,
  syncUploadNowInputSchema
} from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { assertTrustedSender } from './assertTrustedSender'
import { handleIpcRequest } from './handleIpcRequest'

/**
 * Pushes the sanitized status to every live renderer.
 *
 * Main-to-renderer only. There is deliberately no `ipcMain.handle`/`ipcMain.on` for this channel,
 * so a renderer can neither publish nor forge a status: the only way to learn the queue state is to
 * ask main for it, or to be told by main.
 */
export function broadcastSyncChanged(status: SyncStatus): void {
  const payload = syncStatusSchema.parse(status)

  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }

    try {
      window.webContents.send(IPC_CHANNELS.syncChanged, payload)
    } catch {
      // A teardown race in one renderer must not stop delivery to the others — and must never
      // propagate into the worker, whose queue writes are already committed by this point.
    }
  }
}

export function registerSyncIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.syncGetStatus, (event, input: unknown) => {
    assertTrustedSender(event)

    // The worker's view, not the repository's: only the worker knows whether it is paused, and a
    // status that always claimed 'idle' would leave a licence-blocked queue looking healthy.
    return handleIpcRequest(input, syncGetStatusInputSchema, () =>
      syncStatusSchema.parse(services.invoiceUploads.getStatus())
    )
  })

  ipcMain.handle(IPC_CHANNELS.syncUploadNow, (event, input: unknown) => {
    assertTrustedSender(event)

    return handleIpcRequest(input, syncUploadNowInputSchema, () => {
      // A scheduling hint, never an authorization. `requestRun` re-runs the full fail-closed gate
      // (`assertAllowed('sync')`, `pos.invoice.upload`, session ownership, row eligibility, payload
      // integrity) before anything reaches the wire, and terminal rows are unclaimable by
      // construction — so this cannot revive a `conflict`, `rejected` or `synced` row.
      services.invoiceUploads.requestRun()

      return syncStatusSchema.parse(services.invoiceUploads.getStatus())
    })
  })

  ipcMain.handle(IPC_CHANNELS.syncListFailures, (event, input: unknown) => {
    assertTrustedSender(event)

    return handleIpcRequest(input, syncListFailuresInputSchema, (parsed) =>
      syncFailurePageSchema.parse(
        services.invoiceUploadFailures.list(
          parsed?.cursor ?? null,
          parsed?.limit ?? SYNC_FAILURE_PAGE_DEFAULT_SIZE
        )
      )
    )
  })
}
