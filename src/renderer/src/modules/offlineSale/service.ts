import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import type { OfflineSaleReadiness } from '@shared/contracts/offlineSaleReadiness.contract'

/**
 * PS6 — the renderer's only route to offline-sale readiness.
 *
 * One method, no parameters. The renderer cannot name an owner, a clock, a window or an authority,
 * and because the method takes no arguments that is a property of the type rather than a convention
 * someone has to remember (§14.3).
 */
export class OfflineSaleService {
  async getReadiness(): Promise<OfflineSaleReadiness> {
    const result = await window.posApi.offlineSale.getReadiness()

    if (!result.ok) {
      throw publicAppErrorSchema.parse(result.error)
    }

    return result.data
  }
}
