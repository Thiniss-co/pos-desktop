import {
  posCartWidthPreferenceSchema,
  userPreferencesSchema,
  type LocaleCode,
  type PosCartWidthPreference,
  type ThemePreference,
  type UserPreferenceKey,
  type UserPreferences
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

  /** Stage 5: the signed-in user's own preferences; the result shape is checked here. */
  async getUserPreferences(): Promise<UserPreferences> {
    return userPreferencesSchema.parse(unwrapIpcResult(await this.gateway.getUser()))
  }

  async setUserPreference(key: UserPreferenceKey, value: boolean): Promise<UserPreferences> {
    return userPreferencesSchema.parse(unwrapIpcResult(await this.gateway.setUser({ key, value })))
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
