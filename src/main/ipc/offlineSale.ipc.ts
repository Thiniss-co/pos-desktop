import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { ipcFailure } from '@shared/contracts/ipc.contract'
import { offlineSaleReadinessSchema } from '@shared/contracts/offlineSaleReadiness.contract'
import { offlineSaleGetReadinessInputSchema } from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { isPublicAppError } from '../http/apiError'
import { assertTrustedSender } from './assertTrustedSender'
import { handleIpcRequest } from './handleIpcRequest'

/**
 * PS6 — the complete offline-sale IPC surface: one strictly read-only channel.
 *
 * It takes an empty object and returns a projection. That shape is the contract, and it is what
 * makes §14.3's boundary a property of the wire rather than a rule reviewers must remember:
 *
 *  - the renderer cannot supply an owner tuple — main reads it from its own session state;
 *  - it cannot supply a clock, so it cannot lengthen a countdown;
 *  - it cannot supply or name an authority, so it cannot claim permission to sell;
 *  - there is no write channel here at all. A renderer may *observe* readiness. It never grants it.
 *
 * No new generic database or network channel is introduced, and no token or authority hash reaches
 * the renderer — the resource carries only the identifiers and instants an operator display needs.
 */
export function registerOfflineSaleIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.offlineSaleGetReadiness, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return ipcFailure(
        isPublicAppError(error)
          ? error
          : {
              category: 'unexpected',
              message: 'The request could not be completed',
              retryable: false
            }
      )
    }

    return handleIpcRequest(input, offlineSaleGetReadinessInputSchema, () =>
      offlineSaleReadinessSchema.parse(services.readOfflineSaleReadiness())
    )
  })
}
