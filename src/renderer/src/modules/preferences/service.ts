import {
  posCartWidthPreferenceSchema,
  type LocaleCode,
  type PosCartWidthPreference,
  type ThemePreference
} from '@shared/contracts/preferences.contract'
import { unwrapIpcResult } from '@renderer/shared/utils/unwrapIpcResult'

export class PreferencesService {
  constructor(
    private readonly gateway: Window['posApi']['preferences'] = window.posApi.preferences
  ) {}

  async getLocale(): Promise<LocaleCode | null> {
    return unwrapIpcResult(await this.gateway.getLocale())
  }

  async setLocale(locale: LocaleCode): Promise<LocaleCode> {
    return unwrapIpcResult(await this.gateway.setLocale(locale))
  }

  async getTheme(): Promise<ThemePreference | null> {
    return unwrapIpcResult(await this.gateway.getTheme())
  }

  async setTheme(theme: ThemePreference): Promise<ThemePreference> {
    return unwrapIpcResult(await this.gateway.setTheme(theme))
  }

  /**
   * Layout-only POS cart width (px), or `null` for the design default. The preload stays free of
   * runtime validation, so the result shape is checked here: a malformed width degrades to the
   * default instead of ever reaching the layout.
   */
  async getPosCartWidth(): Promise<PosCartWidthPreference> {
    const width = unwrapIpcResult(await this.gateway.getPosCartWidth())
    return posCartWidthPreferenceSchema.safeParse(width).data ?? null
  }

  async setPosCartWidth(width: PosCartWidthPreference): Promise<PosCartWidthPreference> {
    const saved = posCartWidthPreferenceSchema.safeParse(
      unwrapIpcResult(await this.gateway.setPosCartWidth(width))
    )

    if (!saved.success) {
      throw new Error('The cart width preference returned an unexpected shape')
    }

    return saved.data
  }
}
