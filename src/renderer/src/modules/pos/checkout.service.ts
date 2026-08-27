import type { CheckoutIntent, CheckoutPreviewOutcome } from '@shared/contracts/checkout.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

export class CheckoutRendererService {
  constructor(private readonly gateway: Window['posApi']['checkout'] = window.posApi.checkout) {}

  async validate(intent: CheckoutIntent): Promise<CheckoutPreviewOutcome> {
    return unwrapIpcResult(await this.gateway.validate(intent))
  }
}
