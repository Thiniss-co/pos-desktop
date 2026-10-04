import { ipcMain, webContents as allWebContents, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  draftStateSchema,
  installHoldReplySchema,
  installHoldStatusInputSchema,
  workstationRefreshInputSchema,
  workstationRefreshResultSchema,
  type WorkstationRefreshResult
} from '@shared/contracts/catalogInstall.contract'
import { ipcFailure } from '@shared/contracts/ipc.contract'
import type { ApplicationServices } from '../app/applicationServices'
import { isPublicAppError } from '../http/apiError'
import { InstallDeferredError } from '../services/catalogInstallGate.service'
import { assertTrustedSender } from './assertTrustedSender'
import { handleIpcRequest } from './handleIpcRequest'

const untrusted = {
  category: 'authorization',
  message: 'This request could not be verified.',
  retryable: false
} as const

function trusted(event: IpcMainInvokeEvent): boolean {
  try {
    assertTrustedSender(event)
    return true
  } catch {
    return false
  }
}

const watched = new Set<number>()

/** A window that reloads, navigates its main frame or goes away is busy until it reports again. */
function watchWindow(id: number, services: ApplicationServices): void {
  if (watched.has(id)) return
  const contents = allWebContents.fromId(id)
  if (!contents) return
  watched.add(id)
  const forget = (): void => services.installGate.forgetWindow(id)
  contents.on('destroyed', () => {
    forget()
    watched.delete(id)
  })
  contents.on('render-process-gone', forget)
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) forget()
  })
}

/**
 * Rev 4 §8.3 manual path. Human consent (bound to a draft generation) was obtained by the renderer
 * BEFORE this call and outside the machine handshake; a claimed payment is refused up front.
 */
async function manualRefresh(
  services: ApplicationServices,
  consentGeneration: number | null
): Promise<WorkstationRefreshResult> {
  const before = services.catalog.getStatus().contract?.revision ?? null
  const result = (outcome: WorkstationRefreshResult['outcome']): WorkstationRefreshResult => {
    const revision = services.catalog.getStatus().contract?.revision ?? null
    return workstationRefreshResultSchema.parse({
      outcome,
      revision,
      revisionChanged: revision !== before
    })
  }

  if (services.installGate.paymentActive()) {
    return result('payment-active')
  }

  try {
    await services.installGate.withPath('manual', consentGeneration, () =>
      services.catalogRefresh.refresh()
    )
    return result('installed')
  } catch (error) {
    if (error instanceof InstallDeferredError) {
      return result(
        error.reason === 'payment-active'
          ? 'payment-active'
          : error.reason === 'draft-changed'
            ? 'draft-changed'
            : 'busy'
      )
    }
    if (
      isPublicAppError(error) &&
      (error.category === 'authentication' || error.category === 'authorization')
    ) {
      return result('denied')
    }
    return result('failed')
  }
}

export function registerCatalogInstallIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.posDraftState, (event, input: unknown) => {
    if (!trusted(event)) return ipcFailure(untrusted)
    return handleIpcRequest(input, draftStateSchema, (state) => {
      watchWindow(event.sender.id, services)
      services.installGate.reportDraftState(event.sender.id, state)
      if (services.installGate.draftIdle()) {
        services.renewal.onDraftIdle()
      }
      return null
    })
  })

  ipcMain.handle(IPC_CHANNELS.catalogInstallHoldReply, (event, input: unknown) => {
    if (!trusted(event)) return ipcFailure(untrusted)
    return handleIpcRequest(input, installHoldReplySchema, (reply) => {
      services.installGate.reply(event.sender.id, reply)
      return null
    })
  })

  ipcMain.handle(IPC_CHANNELS.catalogInstallHoldStatus, (_event, input: unknown) =>
    handleIpcRequest(input, installHoldStatusInputSchema, (value) => ({
      state: services.installGate.status(value.holdId)
    }))
  )

  ipcMain.handle(IPC_CHANNELS.workstationRefresh, (event, input: unknown) => {
    if (!trusted(event)) return ipcFailure(untrusted)
    return handleIpcRequest(input, workstationRefreshInputSchema, (value) =>
      manualRefresh(services, value.consent?.generation ?? null)
    )
  })
}
