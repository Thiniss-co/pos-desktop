import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {} }))

import { isAllowedNavigation } from './securityPolicy'

const INDEX = new URL('file:///opt/pos/resources/app.asar/out/renderer/index.html')

describe('isAllowedNavigation (production)', () => {
  it("allows the app's own page and any of its hash routes", () => {
    expect(isAllowedNavigation(INDEX.href, undefined, INDEX)).toBe(true)
    expect(isAllowedNavigation(`${INDEX.href}#/pos`, undefined, INDEX)).toBe(true)
  })

  it('refuses any other local file and any remote origin', () => {
    expect(isAllowedNavigation('file:///etc/passwd', undefined, INDEX)).toBe(false)
    expect(isAllowedNavigation('file:///home/cashier/Downloads/index.html', undefined, INDEX)).toBe(
      false
    )
    expect(isAllowedNavigation('https://evil.example/', undefined, INDEX)).toBe(false)
    expect(isAllowedNavigation('not a url', undefined, INDEX)).toBe(false)
  })

  it('allows only the development renderer origin in development', () => {
    const dev = new URL('http://localhost:5173')
    expect(isAllowedNavigation('http://localhost:5173/#/pos', dev, INDEX)).toBe(true)
    expect(isAllowedNavigation(INDEX.href, dev, INDEX)).toBe(false)
  })
})
