import type {
  RefundableInvoice,
  RefundLineSelection,
  RefundOutcome,
  RefundPreview
} from '@shared/contracts/refund.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

/**
 * Plan §5/§6 -- the refund renderer service. Every method sends a narrow SELECTION only; no
 * amount, timestamp, ownership, or idempotency key ever originates here. Main
 * (`RefundService`) is the sole authority for the calculation, the frozen request, and the
 * durable identity.
 */
export class RefundsService {
  constructor(private readonly gateway: Window['posApi']['refunds'] = window.posApi.refunds) {}

  async getRefundable(invoiceLocalUuid: string): Promise<RefundableInvoice> {
    return unwrapIpcResult(await this.gateway.getRefundable({ invoiceLocalUuid }))
  }

  async preview(input: {
    invoiceLocalUuid: string
    lines: RefundLineSelection[]
    stockReturned: boolean
  }): Promise<RefundPreview> {
    return unwrapIpcResult(await this.gateway.preview(input))
  }

  async submit(input: {
    previewId: string
    invoiceLocalUuid: string
    lines: RefundLineSelection[]
    stockReturned: boolean
    paymentMethodUuid: string | null
    reference?: string | null
    reason?: string | null
    notes?: string | null
  }): Promise<RefundOutcome> {
    return unwrapIpcResult(await this.gateway.submit(input))
  }

  async resume(localRefundUuid: string): Promise<RefundOutcome> {
    return unwrapIpcResult(await this.gateway.resume({ localRefundUuid }))
  }

  async cancelPrepared(localRefundUuid: string): Promise<{ cancelled: boolean }> {
    return unwrapIpcResult(await this.gateway.cancelPrepared({ localRefundUuid }))
  }
}
