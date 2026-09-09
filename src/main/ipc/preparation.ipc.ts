import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { ipcFailure } from '@shared/contracts/ipc.contract'
import {
  preparationCycleResultSchema,
  preparationReadinessSchema
} from '@shared/contracts/preparation.contract'
import {
  preparationGetReadinessInputSchema,
  preparationRunCycleInputSchema
} from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { isPublicAppError } from '../http/apiError'
import { assertTrustedSender } from './assertTrustedSender'
import { handleIpcRequest } from './handleIpcRequest'

/**
 * CP4 — the complete preparation IPC surface (plan §10 CP4: "no broad database/network IPC").
 *
 * Two channels, both taking a strict empty object. That is the whole contract, and it is what makes
 * §4's invariant — "renderer cannot supply authoritative quantities, ownership, time, or grant
 * rights" — a property of the boundary rather than a rule reviewers must remember:
 *
 *  - the renderer cannot name a product set (§5.2: main resolves the eligible set; a renderer list
 *    never reaches the wire);
 *  - it cannot name a quantity, a duration, or a target;
 *  - it cannot name an owner tuple — main reads that from its own session and bootstrap state;
 *  - it cannot supply a clock. The countdown is derived from trusted time inside main.
 *
 * A renderer may *ask* for preparation. It never says what to prepare.
 */
export function registerPreparationIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.preparationGetReadiness, (event, input: unknown) => {
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

    return handleIpcRequest(input, preparationGetReadinessInputSchema, () =>
      preparationReadinessSchema.parse(services.readPreparationReadiness())
    )
  })

  ipcMain.handle(IPC_CHANNELS.preparationRunCycle, (event, input: unknown) => {
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

    return handleIpcRequest(input, preparationRunCycleInputSchema, async () =>
      preparationCycleResultSchema.parse(await services.runPreparationCycle())
    )
  })
}
