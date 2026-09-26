import {
  DEFAULT_PRINTER_SETTINGS,
  printerSettingsSchema,
  type PrinterSettings
} from '@shared/contracts/printing.contract'
import type { AppSettingsRepository } from '../repositories/appSettings.repository'

/**
 * Receipt-printing plan §D-2/BD-2 — workstation hardware print settings. Approved BD-2: any
 * active authenticated user may read and change these; they carry no company branding. Stored
 * under one `app_settings` key, following the exact `preferences.ipc.ts` convention (JSON-encoded
 * value, Zod-validated on read, so a corrupt/foreign value never crashes the app -- it just falls
 * back to the default).
 */

const PRINTER_SETTINGS_KEY = 'printing.workstation'

export class PrinterSettingsService {
  constructor(private readonly appSettings: Pick<AppSettingsRepository, 'get' | 'set'>) {}

  get(): PrinterSettings {
    const stored = this.appSettings.get(PRINTER_SETTINGS_KEY)

    if (stored === null) {
      return DEFAULT_PRINTER_SETTINGS
    }

    try {
      const parsed = printerSettingsSchema.safeParse(JSON.parse(stored))
      return parsed.success ? parsed.data : DEFAULT_PRINTER_SETTINGS
    } catch {
      return DEFAULT_PRINTER_SETTINGS
    }
  }

  save(settings: PrinterSettings): PrinterSettings {
    const validated = printerSettingsSchema.parse(settings)
    this.appSettings.set(PRINTER_SETTINGS_KEY, JSON.stringify(validated))
    return validated
  }
}
