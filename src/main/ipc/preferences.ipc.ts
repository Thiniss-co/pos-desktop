import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import { ipcFailure, type IpcResult } from '@shared/contracts/ipc.contract'
import {
  localeCodeSchema,
  posCartWidthSchema,
  themePreferenceSchema,
  type LocaleCode,
  type PosCartWidthPreference,
  type ThemePreference,
  type UserPreferences
} from '@shared/contracts/preferences.contract'
import {
  preferencesGetLocaleInputSchema,
  preferencesSetLocaleInputSchema,
  preferencesGetThemeInputSchema,
  preferencesSetThemeInputSchema,
  preferencesGetPosCartWidthInputSchema,
  preferencesSetPosCartWidthInputSchema,
  preferencesGetUserInputSchema,
  preferencesSetUserInputSchema,
  preferencesGetPosWorkspaceInputSchema,
  preferencesSetPosWorkspaceInputSchema
} from '@shared/validators/ipc.validators'
import type { PosWorkspaceReadResult } from '@shared/contracts/posWorkspace.contract'
import type { ApplicationServices } from '../app/applicationServices'
import { isPublicAppError } from '../http/apiError'
import { assertTrustedSender } from './assertTrustedSender'
import { handleIpcRequest, handleTrustedIpcRequest } from './handleIpcRequest'

const LOCALE_SETTING_KEY = 'ui.locale'
const FALLBACK_LOCALE: LocaleCode = 'en'
const THEME_SETTING_KEY = 'ui.theme'
const FALLBACK_THEME: ThemePreference = 'system'
const POS_CART_WIDTH_SETTING_KEY = 'ui.posCartWidth'

const unexpectedError = {
  category: 'unexpected',
  message: 'The request could not be completed',
  retryable: false
} as const

/**
 * Same guard, same ordering as the checkout channels: the sender is verified before the payload
 * is even parsed. Returns the failure to send back, or `null` when the sender is trusted.
 */
function rejectUntrustedSender<T>(event: IpcMainInvokeEvent): IpcResult<T> | null {
  try {
    assertTrustedSender(event)
    return null
  } catch (error) {
    return isPublicAppError(error) ? ipcFailure(error) : ipcFailure(unexpectedError)
  }
}

/**
 * `ui.posCartWidth` is stored as a plain decimal string; an absent row or `''` means "design
 * default". Anything else that is not a canonical in-range integer (a hand-edited row, a value
 * from a future build with a different range) degrades to the default rather than reaching the
 * renderer — a layout preference must never be able to break the selling screen.
 */
function readStoredPosCartWidth(stored: string | null): PosCartWidthPreference {
  if (stored === null || !/^[1-9]\d{0,3}$/.test(stored)) {
    return null
  }

  return posCartWidthSchema.safeParse(Number(stored)).data ?? null
}

export function registerPreferencesIpcHandlers(services: ApplicationServices): void {
  ipcMain.handle(IPC_CHANNELS.preferencesGetLocale, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, preferencesGetLocaleInputSchema, () => {
      const storedLocale = services.appSettings.get(LOCALE_SETTING_KEY)

      if (storedLocale === null) {
        return null
      }

      return localeCodeSchema.safeParse(storedLocale).data ?? FALLBACK_LOCALE
    })
  )
  ipcMain.handle(IPC_CHANNELS.preferencesSetLocale, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, preferencesSetLocaleInputSchema, (locale) => {
      services.appSettings.set(LOCALE_SETTING_KEY, locale)
      return locale
    })
  )
  ipcMain.handle(IPC_CHANNELS.preferencesGetTheme, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, preferencesGetThemeInputSchema, () => {
      const storedTheme = services.appSettings.get(THEME_SETTING_KEY)

      if (storedTheme === null) {
        return null
      }

      return themePreferenceSchema.safeParse(storedTheme).data ?? FALLBACK_THEME
    })
  )
  ipcMain.handle(IPC_CHANNELS.preferencesSetTheme, (event, input: unknown) =>
    handleTrustedIpcRequest(event, input, preferencesSetThemeInputSchema, (theme) => {
      services.appSettings.set(THEME_SETTING_KEY, theme)
      return theme
    })
  )
  // Layout-only preference: the POS cart column width. Nothing about the sale (cart lines,
  // totals, tender) is ever persisted through this channel.
  ipcMain.handle(IPC_CHANNELS.preferencesGetPosCartWidth, (event, input: unknown) => {
    const rejected = rejectUntrustedSender<PosCartWidthPreference>(event)

    if (rejected) {
      return rejected
    }

    return handleIpcRequest(input, preferencesGetPosCartWidthInputSchema, () =>
      readStoredPosCartWidth(services.appSettings.get(POS_CART_WIDTH_SETTING_KEY))
    )
  })
  ipcMain.handle(IPC_CHANNELS.preferencesSetPosCartWidth, (event, input: unknown) => {
    const rejected = rejectUntrustedSender<PosCartWidthPreference>(event)

    if (rejected) {
      return rejected
    }

    return handleIpcRequest(input, preferencesSetPosCartWidthInputSchema, (width) => {
      services.appSettings.set(POS_CART_WIDTH_SETTING_KEY, width === null ? '' : String(width))
      return width
    })
  })
  // POS improvements, Stage 5: the signed-in user's own preferences (touch layout, auto-print).
  ipcMain.handle(IPC_CHANNELS.preferencesGetUser, (event, input: unknown) => {
    const rejected = rejectUntrustedSender<UserPreferences>(event)

    if (rejected) {
      return rejected
    }

    return handleIpcRequest(input, preferencesGetUserInputSchema, () =>
      services.userPreferences.current()
    )
  })
  ipcMain.handle(IPC_CHANNELS.preferencesSetUser, (event, input: unknown) => {
    const rejected = rejectUntrustedSender<UserPreferences>(event)

    if (rejected) {
      return rejected
    }

    return handleIpcRequest(input, preferencesSetUserInputSchema, (preference) =>
      services.userPreferences.set(preference)
    )
  })
  // POS workspace: presentation-only layout of the signed-in user on this workstation. The owner is
  // the main-process session's; the payload is a strict, bounded layout plus the read's context token.
  ipcMain.handle(IPC_CHANNELS.preferencesGetPosWorkspace, (event, input: unknown) => {
    const rejected = rejectUntrustedSender<PosWorkspaceReadResult>(event)

    if (rejected) {
      return rejected
    }

    return handleIpcRequest(input, preferencesGetPosWorkspaceInputSchema, () =>
      services.workspaceLayout.read()
    )
  })
  ipcMain.handle(IPC_CHANNELS.preferencesSetPosWorkspace, (event, input: unknown) => {
    const rejected = rejectUntrustedSender<PosWorkspaceReadResult>(event)

    if (rejected) {
      return rejected
    }

    return handleIpcRequest(input, preferencesSetPosWorkspaceInputSchema, (request) =>
      services.workspaceLayout.write(request)
    )
  })
}
