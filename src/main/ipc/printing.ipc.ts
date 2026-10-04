import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { printerInfoSchema, type PrinterInfo } from '@shared/contracts/printing.contract'
import {
  printingGetWorkstationSettingsInputSchema,
  printingSaveWorkstationSettingsInputSchema,
  printingListPrintersInputSchema,
  printingPreviewInputSchema,
  printingDispatchInputSchema,
  printingGetJobInputSchema,
  printingCancelJobInputSchema,
  printingLatestForDocumentInputSchema,
  printingAutoPrintStatusInputSchema,
  printingAutoPrintSetupInputSchema,
  printingAutoPrintNoticesInputSchema,
  printingAutoPrintDismissNoticesInputSchema
} from '@shared/validators/ipc.validators'
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
 * Receipt-printing plan §D-6/§D-5 — narrow, typed printing channels. `preview`/`dispatch`/
 * `get-job`/`cancel-job`/`latest-for-document` resolve the caller via `ReceiptAccessService`
 * (`pos.view` + ownership) BEFORE touching any stored job or document, exactly like every other
 * receipt read. `get-workstation-settings`/`save-workstation-settings`/`list-printers` require
 * only an active session (BD-2, approved): they carry no company branding.
 */
export function registerPrintingIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.printingGetWorkstationSettings, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }
    return handleIpcRequest(input, printingGetWorkstationSettingsInputSchema, () => {
      services.receiptAccess.resolveCaller() // requires an active session
      return services.printerSettings.get()
    })
  })

  ipcMain.handle(IPC_CHANNELS.printingSaveWorkstationSettings, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }
    return handleIpcRequest(input, printingSaveWorkstationSettingsInputSchema, (settings) => {
      services.receiptAccess.resolveCaller()
      return services.printerSettings.save(settings)
    })
  })

  ipcMain.handle(IPC_CHANNELS.printingListPrinters, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }
    return handleIpcRequest(input, printingListPrintersInputSchema, async () => {
      services.receiptAccess.resolveCaller()
      const printers = await services.receiptPrinting.listPrinters()
      const validated: PrinterInfo[] = printers.map((printer) => printerInfoSchema.parse(printer))
      return validated
    })
  })

  ipcMain.handle(IPC_CHANNELS.printingPreview, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }
    return handleIpcRequest(input, printingPreviewInputSchema, async (query) => {
      const owner = services.receiptAccess.resolveCaller()
      return services.receiptPrinting.preview(owner, query)
    })
  })

  ipcMain.handle(IPC_CHANNELS.printingDispatch, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }
    return handleIpcRequest(input, printingDispatchInputSchema, async (query) => {
      const owner = services.receiptAccess.resolveCaller()
      return services.receiptPrinting.dispatch(owner, query)
    })
  })

  ipcMain.handle(IPC_CHANNELS.printingGetJob, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }
    return handleIpcRequest(input, printingGetJobInputSchema, (query) => {
      const owner = services.receiptAccess.resolveCaller()
      return services.receiptPrinting.getJob(owner, query.requestId)
    })
  })

  ipcMain.handle(IPC_CHANNELS.printingCancelJob, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }
    return handleIpcRequest(input, printingCancelJobInputSchema, (query) => {
      const owner = services.receiptAccess.resolveCaller()
      return services.receiptPrinting.cancelJob(owner, query.requestId)
    })
  })

  ipcMain.handle(IPC_CHANNELS.printingLatestForDocument, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }
    return handleIpcRequest(input, printingLatestForDocumentInputSchema, (query) => {
      const owner = services.receiptAccess.resolveCaller()
      const documentLocalUuid =
        query.document.kind === 'test'
          ? 'test'
          : query.document.kind === 'sale'
            ? query.document.invoiceLocalUuid
            : query.document.refundLocalUuid
      return services.receiptPrinting.latestForDocument(
        owner,
        query.document.kind,
        documentLocalUuid
      )
    })
  })

  // POS improvements, Stage 7: automatic printing. Each resolves the caller first (session and
  // pos.view); the status is readable only for a sale of the caller's register and user.
  ipcMain.handle(IPC_CHANNELS.printingAutoPrintStatus, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }
    return handleIpcRequest(input, printingAutoPrintStatusInputSchema, (query) => {
      const owner = services.receiptAccess.resolveCaller()
      return services.autoPrint.statusForSale(owner, query.invoiceLocalUuid)
    })
  })

  ipcMain.handle(IPC_CHANNELS.printingAutoPrintSetup, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }
    return handleIpcRequest(input, printingAutoPrintSetupInputSchema, () => {
      services.receiptAccess.resolveCaller()
      return services.autoPrint.setup()
    })
  })

  ipcMain.handle(IPC_CHANNELS.printingAutoPrintNotices, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }
    return handleIpcRequest(input, printingAutoPrintNoticesInputSchema, () =>
      services.autoPrint.noticesFor(services.receiptAccess.resolveCaller())
    )
  })

  ipcMain.handle(IPC_CHANNELS.printingAutoPrintDismissNotices, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }
    return handleIpcRequest(input, printingAutoPrintDismissNoticesInputSchema, () => {
      services.autoPrint.dismissNotices(services.receiptAccess.resolveCaller())
      return { dismissed: true }
    })
  })
}
