import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  refundsCancelPreparedInputSchema,
  refundsGetRefundableInputSchema,
  refundsPreviewInputSchema,
  refundsResumeInputSchema,
  refundsSubmitInputSchema,
  salesGetInvoiceInputSchema,
  salesListInvoicesInputSchema
} from '@shared/validators/ipc.validators'
import type {
  SaleDetail,
  SalesInvoiceList,
  SalesInvoiceSummary
} from '@shared/contracts/refund.contract'
import type { ApplicationServices } from '../app/applicationServices'
import { isPublicAppError } from '../http/apiError'
import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import { ipcFailure } from '@shared/contracts/ipc.contract'
import { assertTrustedSender } from './assertTrustedSender'
import { handleIpcRequest } from './handleIpcRequest'

const unexpectedError = {
  category: 'unexpected',
  message: 'The request could not be completed',
  retryable: false
} as const

/**
 * Plan §5 -- narrow, typed refund and sales-history channels. Every write channel follows the
 * checkout form (`assertTrustedSender` wrapped so a rejection becomes an `ipcFailure`, not an
 * unhandled rejection). The renderer sends intents only: invoice/line/payment SELECTIONS, never
 * amounts, totals, timestamps, ownership, or the idempotency key -- those are all resolved and
 * frozen by `RefundService`.
 */
export function registerRefundsIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.salesListInvoices, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }

    return handleIpcRequest(input, salesListInvoicesInputSchema, (query) => {
      const owner = services.shiftAuthority.captureContext()
      const { rows, nextCursor } = services.localSaleRepository.listInvoices(owner, query)

      const summaries: SalesInvoiceSummary[] = rows.map((row) => {
        const openRefund = services.localRefunds.findOpenForInvoice(row.localUuid)

        return {
          invoiceLocalUuid: row.localUuid,
          offlineNumber: row.offlineNumber,
          serverNumber: row.serverNumber,
          displayNumber: row.serverNumber ?? row.offlineNumber,
          soldAt: row.soldAt,
          grandTotalAmount: row.grandTotalAmount,
          currency: row.currency,
          currencyExponent: row.currencyExponent,
          syncStatus: row.syncStatus,
          hasOpenRefund: openRefund !== null
        }
      })

      const result: SalesInvoiceList = { invoices: summaries, nextCursor }
      return result
    })
  })

  ipcMain.handle(IPC_CHANNELS.salesGetInvoice, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }

    return handleIpcRequest(input, salesGetInvoiceInputSchema, ({ invoiceLocalUuid }) => {
      const row = services.localSaleRepository.findInvoiceByLocalUuid(invoiceLocalUuid)

      if (!row) {
        throw publicAppErrorSchema.parse({
          category: 'validation',
          message: 'This sale could not be found on this workstation.',
          backendCode: 'refund_invoice_not_found',
          retryable: false
        })
      }

      const items = services.localSaleRepository.itemsForInvoice(invoiceLocalUuid)
      const payments = services.localSaleRepository.paymentsForInvoice(invoiceLocalUuid)
      const openRefund = services.localRefunds.findOpenForInvoice(invoiceLocalUuid)
      const refunds = services.localRefunds.refundsForInvoice(invoiceLocalUuid)

      const detail: SaleDetail = {
        invoice: {
          localUuid: row.localUuid,
          offlineNumber: row.offlineNumber,
          serverNumber: row.serverNumber,
          displayNumber: row.serverNumber ?? row.offlineNumber,
          remoteUuid: row.remoteUuid,
          syncStatus: row.syncStatus,
          soldAt: row.soldAt,
          currency: row.currency,
          currencyExponent: row.currencyExponent,
          grandTotalAmount: row.grandTotalAmount
        },
        items: items.map((item) => ({
          localUuid: item.localUuid,
          productName: item.productName,
          sku: item.sku,
          quantityMilli: item.quantityMilli,
          unitPriceAmount: item.unitPriceAmount,
          totalAmount: item.totalAmount
        })),
        payments: payments.map((payment) => ({
          localUuid: payment.localUuid,
          type: payment.type,
          amount: payment.amount,
          reference: payment.reference
        })),
        openRefund: openRefund
          ? {
              localUuid: openRefund.localUuid,
              submissionState: openRefund.submissionState,
              grandTotalAmount: openRefund.grandTotalAmount,
              refundNumber: openRefund.refundNumber,
              remoteUuid: openRefund.remoteUuid
            }
          : null,
        refunds: refunds.map((refund) => ({
          localUuid: refund.localUuid,
          submissionState: refund.submissionState,
          grandTotalAmount: refund.grandTotalAmount,
          refundNumber: refund.refundNumber,
          remoteUuid: refund.remoteUuid
        }))
      }

      return detail
    })
  })

  ipcMain.handle(IPC_CHANNELS.refundsGetRefundable, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }

    return handleIpcRequest(input, refundsGetRefundableInputSchema, ({ invoiceLocalUuid }) =>
      services.refunds.getRefundableInvoice(invoiceLocalUuid)
    )
  })

  ipcMain.handle(IPC_CHANNELS.refundsPreview, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }

    return handleIpcRequest(input, refundsPreviewInputSchema, (intent) =>
      services.refunds.previewRefund(intent)
    )
  })

  ipcMain.handle(IPC_CHANNELS.refundsSubmit, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }

    return handleIpcRequest(input, refundsSubmitInputSchema, (intent) =>
      services.refunds.submitRefund(intent)
    )
  })

  ipcMain.handle(IPC_CHANNELS.refundsResume, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }

    return handleIpcRequest(input, refundsResumeInputSchema, ({ localRefundUuid }) =>
      services.refunds.resumeRefund(localRefundUuid)
    )
  })

  ipcMain.handle(IPC_CHANNELS.refundsCancelPrepared, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }

    return handleIpcRequest(input, refundsCancelPreparedInputSchema, ({ localRefundUuid }) => ({
      cancelled: services.refunds.cancelPreparedRefund(localRefundUuid)
    }))
  })
}
