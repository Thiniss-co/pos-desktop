import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { localeCodeSchema, type LocaleCode } from '@shared/contracts/preferences.contract'
import {
  preferencesGetLocaleInputSchema,
  preferencesSetLocaleInputSchema
} from '@shared/validators/ipc.validators'
import type { ApplicationServices } from '../app/applicationServices'
import { handleIpcRequest } from './handleIpcRequest'

const LOCALE_SETTING_KEY = 'ui.locale'
const FALLBACK_LOCALE: LocaleCode = 'en'

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
}
