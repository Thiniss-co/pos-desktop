import { z } from 'zod'

export const localeCodeSchema = z.enum(['en', 'ar'])

export type LocaleCode = z.infer<typeof localeCodeSchema>
