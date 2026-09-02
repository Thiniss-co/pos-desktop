import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  commercialAccessSnapshotSchema,
  type CommercialAccessSnapshot
} from '@shared/contracts/license.contract'
import {
  licenseGetAccessInputSchema,
  licenseValidateInputSchema
} from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleIpcRequest } from './handleIpcRequest'

interface CommercialAccessDescriber {
  describe(): CommercialAccessSnapshot
}

/**
 * Publishes renderer-safe access projections only. A caller reserves its revision before any
 * asynchronous work; an older operation that completes after a newer one is discarded.
 */
export class CommercialAccessPublisher {
  private newestRevision = 0
  private publishedRevision = 0
  private readonly listeners = new Set<() => void>()

  constructor(private readonly access: CommercialAccessDescriber) {}

  /**
   * Observes *actual* access publications in the main process.
   *
   * This is the authoritative access-change signal: licence validation, bootstrap completion,
   * catalog refresh and connectivity transitions all publish through `publish()`, so one
   * subscription here covers every one of them. Listeners fire only when a publication is really
   * applied — a superseded revision notifies nobody, which is what keeps a burst of overlapping
   * refreshes from fanning out into a burst of scheduling hints.
   *
   * A listener is a **hint only**. It carries no authority: it says "access may have changed",
   * never "access is granted". The renderer cannot reach this, and nothing it receives is trusted.
   */
  onPublished(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  begin(): number {
    this.newestRevision += 1
    return this.newestRevision
  }

  publish(revision: number): void {
    if (revision !== this.newestRevision || revision <= this.publishedRevision) {
      return
    }

    const payload = commercialAccessSnapshotSchema.parse(this.access.describe())

    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) {
        continue
      }

      try {
        window.webContents.send(IPC_CHANNELS.licenseAccessChanged, payload)
      } catch {
        // A teardown race in one renderer must not interfere with other windows or access state.
      }
    }

    this.publishedRevision = revision

    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A hint consumer must never be able to break access publication for the renderer or for
        // the other listeners. The worker re-derives its own authority regardless.
      }
    }
  }

  publishCurrent(): void {
    const revision = this.begin()
    this.publish(revision)
  }
}

export function registerLicenseIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.licenseValidate, (_event, input: unknown) =>
    handleIpcRequest(input, licenseValidateInputSchema, async () => {
      const revision = services.commercialAccessPublisher.begin()
      await services.license.validate()
      services.commercialAccessPublisher.publish(revision)
      return commercialAccessSnapshotSchema.parse(services.commercialAccess.describe())
    })
  )

  ipcMain.handle(IPC_CHANNELS.licenseGetAccess, (_event, input: unknown) =>
    handleIpcRequest(input, licenseGetAccessInputSchema, () => services.commercialAccess.describe())
  )
}
