// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { applyBrandTokens, useBrandingStore } from './store'

/** Owner UX plan P9 — tokens on the document root follow the delivered identity, and leave no trace. */
afterEach(() => {
  applyBrandTokens(null)
  vi.unstubAllGlobals()
})

describe('branding store', () => {
  it('applies light-dark brand tokens for a colour and removes every one of them for none', () => {
    const root = document.documentElement
    applyBrandTokens('#0e9f8e', root)
    expect(root.style.getPropertyValue('--color-pri')).toBe('light-dark(#0e9f8e, #0e9f8e)')
    expect(root.style.getPropertyValue('--color-on-pri')).toMatch(
      /^light-dark\(#(000000|ffffff), #(000000|ffffff)\)$/
    )

    applyBrandTokens(null, root)
    expect(root.getAttribute('style') ?? '').not.toContain('--color-')
  })

  it('takes only the latest answer, and clear() restores the default brand', async () => {
    setActivePinia(createPinia())
    let resolveFirst: (value: unknown) => void = () => undefined
    const get = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(async () => ({
        ok: true,
        data: { companyName: 'B', primaryColor: '#2563eb', logoDataUrl: null }
      }))
    vi.stubGlobal('posApi', { branding: { get, onChanged: () => () => undefined } })
    Object.assign(window, { posApi: { branding: { get, onChanged: () => () => undefined } } })
    const store = useBrandingStore()

    const first = store.load()
    await store.load()
    resolveFirst({
      ok: true,
      data: { companyName: 'A', primaryColor: '#e11d48', logoDataUrl: null }
    })
    await first
    expect(store.view.companyName).toBe('B')
    expect(document.documentElement.style.getPropertyValue('--color-pri')).toBe(
      'light-dark(#2563eb, #2563eb)'
    )

    store.clear()
    expect(store.view).toEqual({ companyName: null, primaryColor: null, logoDataUrl: null })
    expect(document.documentElement.style.getPropertyValue('--color-pri')).toBe('')
  })
})
