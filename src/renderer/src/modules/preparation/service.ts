import { publicAppErrorSchema } from '@shared/contracts/api.contract'
import type {
  PreparationCycleResult,
  PreparationReadiness
} from '@shared/contracts/preparation.contract'

/**
 * CP4 — the renderer's only route to preparation.
 *
 * Both calls take no arguments, mirroring the preload surface exactly. The renderer never names a
 * product, a quantity, a duration, an owner, or a clock (§5.2, §4) — and because the methods have
 * no parameters, that is a property of the type rather than a convention.
 */
export class PreparationService {
  async getReadiness(): Promise<PreparationReadiness> {
    const result = await window.posApi.preparation.getReadiness()

    if (!result.ok) {
      throw publicAppErrorSchema.parse(result.error)
    }

    return result.data
  }

  async runCycle(): Promise<PreparationCycleResult> {
    const result = await window.posApi.preparation.runCycle()

    if (!result.ok) {
      throw publicAppErrorSchema.parse(result.error)
    }

    return result.data
  }
}
