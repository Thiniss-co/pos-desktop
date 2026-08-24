import type { LocaleCode, ThemePreference } from '@shared/contracts/preferences.contract'
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
}
