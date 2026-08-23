import { describe, expect, it } from 'vitest'
import {
  preferencesGetLocaleInputSchema,
  preferencesSetLocaleInputSchema
} from '@shared/validators/ipc.validators'
import { handleIpcRequest } from './handleIpcRequest'

// See connectivity.ipc.test.ts for why this stays at the validator/handleIpcRequest layer instead
// of importing preferences.ipc.ts directly (it imports `electron`, which is not a real API outside
// a running Electron process).
describe('preferences IPC validation', () => {
  it('rejects any input for getLocale', async () => {
    const result = await handleIpcRequest(
      { locale: 'en' },
      preferencesGetLocaleInputSchema,
      () => 'not called'
    )

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
  })

  it('accepts only "en" or "ar" for setLocale, rejecting an arbitrary locale string', async () => {
    const accepted = await handleIpcRequest(
      'ar',
      preferencesSetLocaleInputSchema,
      (locale) => locale
    )
    expect(accepted).toEqual({ ok: true, data: 'ar' })

    const rejected = await handleIpcRequest(
      'fr',
      preferencesSetLocaleInputSchema,
      () => 'not called'
    )
    expect(rejected).toMatchObject({ ok: false, error: { category: 'validation' } })

    const rejectedInjection = await handleIpcRequest(
      "en'; DROP TABLE app_settings; --",
      preferencesSetLocaleInputSchema,
      () => 'not called'
    )
    expect(rejectedInjection).toMatchObject({ ok: false, error: { category: 'validation' } })
  })
})
