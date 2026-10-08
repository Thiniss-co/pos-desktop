import { describe, expect, it } from 'vitest'
import { loadRuntimeConfig } from './runtimeConfig'

describe('loadRuntimeConfig', () => {
  it('reports an honest not-configured state when no API origin is provided', () => {
    expect(loadRuntimeConfig({}).apiConfiguration).toBe('not_configured')
  })

  it('accepts a loopback HTTP origin for local development', () => {
    expect(
      loadRuntimeConfig({ MAIN_VITE_POS_API_ORIGIN: 'http://127.0.0.1:8000' }).apiOrigin?.origin
    ).toBe('http://127.0.0.1:8000')
  })

  it('refuses the loopback HTTP origin in a packaged till unless the test build opted in', () => {
    const loopback = { MAIN_VITE_POS_API_ORIGIN: 'http://127.0.0.1:8000' }

    expect(loadRuntimeConfig(loopback, { packaged: true })).toEqual({
      apiConfiguration: 'not_configured',
      apiOrigin: null
    })
    expect(
      loadRuntimeConfig(
        { ...loopback, MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN: 'true' },
        { packaged: true }
      ).apiOrigin?.origin
    ).toBe('http://127.0.0.1:8000')
    expect(
      loadRuntimeConfig(
        { MAIN_VITE_POS_API_ORIGIN: 'https://pos.example.test' },
        { packaged: true }
      ).apiOrigin?.origin
    ).toBe('https://pos.example.test')
  })

  it('rejects non-loopback HTTP origins', () => {
    expect(() => loadRuntimeConfig({ MAIN_VITE_POS_API_ORIGIN: 'http://example.test' })).toThrow(
      'must use HTTPS'
    )
  })
})
