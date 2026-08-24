import { z } from 'zod'

export const localeCodeSchema = z.enum(['en', 'ar'])

export type LocaleCode = z.infer<typeof localeCodeSchema>

export const themePreferenceSchema = z.enum(['light', 'dark', 'system'])

export type ThemePreference = z.infer<typeof themePreferenceSchema>

/** The theme actually painted on screen once `system` is resolved against the OS preference. */
export type ResolvedTheme = Exclude<ThemePreference, 'system'>
