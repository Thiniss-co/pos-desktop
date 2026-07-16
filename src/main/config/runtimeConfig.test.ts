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

  it('rejects non-loopback HTTP origins', () => {
    expect(() => loadRuntimeConfig({ MAIN_VITE_POS_API_ORIGIN: 'http://example.test' })).toThrow(
      'must use HTTPS'
    )
  })
})
