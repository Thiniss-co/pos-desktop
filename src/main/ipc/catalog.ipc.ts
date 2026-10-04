import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  catalogFindByBarcodeInputSchema,
  catalogGetCustomerInputSchema,
  catalogGetProductForSaleInputSchema,
  catalogGetProductInputSchema,
  catalogGetStatusInputSchema,
  catalogListCategoriesInputSchema,
  catalogListPaymentMethodsInputSchema,
  catalogRefreshInputSchema,
  catalogSearchCustomersInputSchema,
  catalogSearchProductsInputSchema
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

export interface CatalogChangedPayload {
  readonly reason: 'stock' | 'snapshot'
  readonly revision: string | null
}

/**
 * POS reliability rev 3: tells every live renderer that locally readable catalog/stock data may
 * have changed. Sent only AFTER the writing transaction committed. Main → renderer only (no
 * handler exists for this channel), and it carries no quantities: the renderer re-reads through
 * the normal validated channels.
 */
export function broadcastCatalogChanged(payload: CatalogChangedPayload): void {
  const safe: CatalogChangedPayload = {
    reason: payload.reason === 'snapshot' ? 'snapshot' : 'stock',
    revision:
      typeof payload.revision === 'string' && /^[a-f0-9]{64}$/.test(payload.revision)
        ? payload.revision
        : null
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(IPC_CHANNELS.catalogChanged, safe)
    } catch {
      // A teardown race in one renderer must not stop delivery to the others.
    }
  }
}

export function registerCatalogIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.catalogGetStatus, (_event, input: unknown) =>
    handleIpcRequest(input, catalogGetStatusInputSchema, () => services.catalog.getStatus())
  )
  // `catalog:refresh` is the only catalog channel that changes durable state and reaches the
  // network, so it is the only one that carries the trusted-sender check — asserted *before* the
  // payload is parsed, exactly like the checkout write channels.
  ipcMain.handle(IPC_CHANNELS.catalogRefresh, (event, input: unknown) => {
    try {
      assertTrustedSender(event)
    } catch (error) {
      return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
    }

    // Rev 4 §8.3: an explicit refresh is the manual install path. Without a consent generation the
    // renderer admits the hold only for an empty draft; the header control supplies consent.
    return handleIpcRequest(input, catalogRefreshInputSchema, () =>
      services.installGate.withPath('manual', null, () => services.catalogRefresh.refresh())
    )
  })

  ipcMain.handle(IPC_CHANNELS.catalogListCategories, (_event, input: unknown) =>
    handleIpcRequest(input, catalogListCategoriesInputSchema, () =>
      services.catalog.listCategories()
    )
  )
  ipcMain.handle(IPC_CHANNELS.catalogSearchProducts, (_event, input: unknown) =>
    handleIpcRequest(input, catalogSearchProductsInputSchema, (value) =>
      services.stockView.searchPage(value)
    )
  )
  ipcMain.handle(IPC_CHANNELS.catalogGetProduct, (_event, input: unknown) =>
    handleIpcRequest(input, catalogGetProductInputSchema, (value) =>
      services.catalog.getProduct(value.uuid)
    )
  )
  ipcMain.handle(IPC_CHANNELS.catalogGetProductForSale, (_event, input: unknown) =>
    handleIpcRequest(input, catalogGetProductForSaleInputSchema, (value) =>
      services.stockView.productForSale(value.uuid)
    )
  )

  ipcMain.handle(IPC_CHANNELS.catalogFindByBarcode, (_event, input: unknown) =>
    handleIpcRequest(input, catalogFindByBarcodeInputSchema, (value) =>
      services.stockView.barcodeForSale(value.barcode)
    )
  )
  ipcMain.handle(IPC_CHANNELS.catalogListPaymentMethods, (_event, input: unknown) =>
    handleIpcRequest(input, catalogListPaymentMethodsInputSchema, () =>
      services.catalog.listPaymentMethods()
    )
  )
  ipcMain.handle(IPC_CHANNELS.catalogSearchCustomers, (_event, input: unknown) =>
    handleIpcRequest(input, catalogSearchCustomersInputSchema, (value) =>
      services.catalog.searchCustomers(value)
    )
  )
  ipcMain.handle(IPC_CHANNELS.catalogGetCustomer, (_event, input: unknown) =>
    handleIpcRequest(input, catalogGetCustomerInputSchema, (value) =>
      services.catalog.getCustomer(value.uuid)
    )
  )
}
