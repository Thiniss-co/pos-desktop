import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import {
  localeCodeSchema,
  themePreferenceSchema,
  type LocaleCode,
  type ThemePreference
} from '@shared/contracts/preferences.contract'
import {
  preferencesGetLocaleInputSchema,
  preferencesSetLocaleInputSchema,
  preferencesGetThemeInputSchema,
  preferencesSetThemeInputSchema
} from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleIpcRequest } from './handleIpcRequest'

const LOCALE_SETTING_KEY = 'ui.locale'
const FALLBACK_LOCALE: LocaleCode = 'en'
const THEME_SETTING_KEY = 'ui.theme'
const FALLBACK_THEME: ThemePreference = 'system'

export function registerPreferencesIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.preferencesGetLocale, (_event, input: unknown) =>
    handleIpcRequest(input, preferencesGetLocaleInputSchema, () => {
      const storedLocale = services.appSettings.get(LOCALE_SETTING_KEY)

      if (storedLocale === null) {
        return null
      }

      return localeCodeSchema.safeParse(storedLocale).data ?? FALLBACK_LOCALE
    })
  )
  ipcMain.handle(IPC_CHANNELS.preferencesSetLocale, (_event, input: unknown) =>
    handleIpcRequest(input, preferencesSetLocaleInputSchema, (locale) => {
      services.appSettings.set(LOCALE_SETTING_KEY, locale)
      return locale
    })
  )
  ipcMain.handle(IPC_CHANNELS.preferencesGetTheme, (_event, input: unknown) =>
    handleIpcRequest(input, preferencesGetThemeInputSchema, () => {
      const storedTheme = services.appSettings.get(THEME_SETTING_KEY)

      if (storedTheme === null) {
        return null
      }

      return themePreferenceSchema.safeParse(storedTheme).data ?? FALLBACK_THEME
    })
  )
  ipcMain.handle(IPC_CHANNELS.preferencesSetTheme, (_event, input: unknown) =>
    handleIpcRequest(input, preferencesSetThemeInputSchema, (theme) => {
      services.appSettings.set(THEME_SETTING_KEY, theme)
      return theme
    })
  )
}
