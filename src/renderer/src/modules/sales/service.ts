import type { SaleDetail, SalesInvoiceList } from '@shared/contracts/refund.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

/**
 * Plan §6 -- the local-first sales-history service. `listInvoices`/`getInvoice` read what already
 * synced or is queued locally; they are never the refund authority (see `RefundsService`).
 */
export class SalesService {
  constructor(private readonly gateway: Window['posApi']['sales'] = window.posApi.sales) {}

  async listInvoices(input: {
    search?: string
    limit?: number
    cursor?: string | null
  }): Promise<SalesInvoiceList> {
    return unwrapIpcResult(await this.gateway.listInvoices(input))
  }

  async getInvoice(invoiceLocalUuid: string): Promise<SaleDetail> {
    return unwrapIpcResult(await this.gateway.getInvoice({ invoiceLocalUuid }))
  }
}
