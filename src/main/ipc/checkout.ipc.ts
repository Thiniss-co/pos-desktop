import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import type {
  CheckoutAttemptStatus,
  CheckoutRecoveryState
} from '@shared/contracts/checkout.contract'
import {
  checkoutAbandonAttemptInputSchema,
  checkoutAcknowledgeAttemptInputSchema,
  checkoutAttemptStatusInputSchema,
  checkoutCompleteInputSchema,
  checkoutPendingAttemptsInputSchema,
  checkoutRetryAttemptInputSchema,
  checkoutValidateInputSchema
} from '@shared/validators/ipc.validators'
import type { PendingAttemptsResult, RecoverySummary } from '../services/localSale.service'
import type { ApplicationServices } from '../app/applicationServices'
import { isPublicAppError } from '../http/apiError'
import { ipcFailure } from '@shared/contracts/ipc.contract'
import { assertTrustedSender } from './assertTrustedSender'
import { handleIpcRequest } from './handleIpcRequest'

const unexpectedError = {
  category: 'unexpected',
  message: 'The request could not be completed',
  retryable: false
} as const

/**
 * `checkout:pending-attempts` (plan §2.9) is deliberately narrower than the raw `sale_attempts`
 * rows `LocalSaleService.pendingAttempts()` reads — `intent_json`, fingerprints, and origin columns
 * never cross the IPC boundary. Matches `checkoutRecoveryStateSchema` in `checkout.contract.ts`.
 */
function toRecoveryState(
  result: PendingAttemptsResult,
  summarize: (row: NonNullable<PendingAttemptsResult['blockingAttempt']>) => RecoverySummary
): CheckoutRecoveryState {
  return {
    blockingAttempt: result.blockingAttempt
      ? {
          attemptKey: result.blockingAttempt.attemptKey,
          state: 'claimed',
          claimedAt: result.blockingAttempt.claimedAt,
          recovery: summarize(result.blockingAttempt)
        }
      : null,
    unacknowledgedResults: result.unacknowledgedResults.map((row) => ({
      attemptKey: row.attemptKey,
      committedAt: row.committedAt as string
    })),
    nextCursor: result.nextCursor
  }
}

export function registerCheckoutIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.checkoutValidate, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }

    return handleIpcRequest(input, checkoutValidateInputSchema, (intent) =>
      services.checkoutPreview.validate(intent)
    )
  })

  // Plan §2.9: five narrow, typed channels — one write per state transition, one read-only
  // discovery channel. Every handler re-derives the owner from main-owned state inside
  // `LocalSaleService`; no renderer-supplied identity, price, tax, or total ever crosses in.
  //
  // CP-5D: `complete` and `retry-attempt` go through `SaleCompletionService`, which owns the
  // ordering "durable claim → exact-deficit allocation acquisition → authoritative local-sale
  // transaction". Company, device, branch, warehouse, allocation identity, revision, and lifecycle
  // status stay main-derived and cannot be supplied over IPC. The other three never touch the
  // network.
  ipcMain.handle(IPC_CHANNELS.checkoutComplete, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }

    return handleIpcRequest(input, checkoutCompleteInputSchema, ({ attemptKey, intent }) =>
      services.saleCompletion.complete(attemptKey, intent)
    )
  })

  ipcMain.handle(IPC_CHANNELS.checkoutRetryAttempt, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }

    return handleIpcRequest(input, checkoutRetryAttemptInputSchema, ({ attemptKey }) =>
      services.saleCompletion.retry(attemptKey)
    )
  })

  ipcMain.handle(IPC_CHANNELS.checkoutAbandonAttempt, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }

    return handleIpcRequest(
      input,
      checkoutAbandonAttemptInputSchema,
      ({ attemptKey, acknowledgeLegacyUncertainty }) =>
        services.localSale.abandon(attemptKey, {
          acknowledgeLegacyUncertainty: acknowledgeLegacyUncertainty === true
        })
    )
  })

  ipcMain.handle(IPC_CHANNELS.checkoutAcknowledgeAttempt, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }

    return handleIpcRequest(input, checkoutAcknowledgeAttemptInputSchema, ({ attemptKey }) =>
      services.localSale.acknowledge(attemptKey)
    )
  })

  ipcMain.handle(IPC_CHANNELS.checkoutPendingAttempts, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }

    return handleIpcRequest(input, checkoutPendingAttemptsInputSchema, ({ limit, after }) =>
      toRecoveryState(services.localSale.pendingAttempts(limit, after ?? null), (row) =>
        services.localSale.recoverySummary(row)
      )
    )
  })

  // POS reliability rev 3: owner-scoped, read-only reconciliation after an IPC failure or a
  // renderer recreation. Main stays authoritative; the renderer never infers "the sale failed".
  ipcMain.handle(IPC_CHANNELS.checkoutAttemptStatus, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }

    return handleIpcRequest(
      input,
      checkoutAttemptStatusInputSchema,
      ({ attemptKey }): CheckoutAttemptStatus => {
        const status = services.localSale.attemptStatus(attemptKey)
        const inFlight = services.saleCompletion.isInFlight(attemptKey)

        return {
          attemptKey,
          // A claim that main is still working on is reported as such; everything else is the
          // durable row's state (or `unknown` for no row owned by this cashier).
          state:
            inFlight && (status.state === 'claimed' || status.state === 'unknown')
              ? 'in-flight'
              : status.state,
          failureCode: status.failureCode,
          ...(status.recovery ? { recovery: status.recovery } : {})
        }
      }
    )
  })
}
