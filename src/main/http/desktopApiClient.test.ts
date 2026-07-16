import { describe, expect, it } from 'vitest'
import { resolveDesktopApiUrl } from './desktopApiClient'

describe('resolveDesktopApiUrl', () => {
  const apiOrigin = new URL('https://api.example.test')

  it('keeps requests inside the desktop namespace', () => {
    expect(resolveDesktopApiUrl(apiOrigin, '/bootstrap').toString()).toBe(
      'https://api.example.test/api/v1/desktop/bootstrap'
    )
  })

  it.each(['/api/v1/admin/users', '/api/v1/auth/login', 'https://example.test', '/../bootstrap'])(
    'rejects forbidden path %s',
    (path) => {
      expect(() => resolveDesktopApiUrl(apiOrigin, path)).toThrow(
        'Only relative desktop API paths are allowed'
      )
    }
  )
})
