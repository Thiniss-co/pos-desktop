import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'

const { getDevelopmentRendererUrl, isAllowedNavigation } = vi.hoisted(() => ({
  getDevelopmentRendererUrl: vi.fn((): URL | undefined => undefined),
  isAllowedNavigation: vi.fn((): boolean => true)
}))

vi.mock('../security/securityPolicy', () => ({ getDevelopmentRendererUrl, isAllowedNavigation }))

import { assertTrustedSender } from './assertTrustedSender'

function eventWithFrame(
  frame: { readonly parent: unknown; readonly url: string } | null
): IpcMainInvokeEvent {
  return { senderFrame: frame } as unknown as IpcMainInvokeEvent
}

describe('assertTrustedSender', () => {
  it('allows a main-frame sender at a trusted origin', () => {
    isAllowedNavigation.mockReturnValue(true)
    expect(() =>
      assertTrustedSender(eventWithFrame({ parent: null, url: 'file:///index.html' }))
    ).not.toThrow()
  })

  it('rejects a missing sender frame', () => {
    expect(() => assertTrustedSender(eventWithFrame(null))).toThrow(
      expect.objectContaining({ category: 'authorization' })
    )
  })

  it('rejects a sender frame that is not the application main frame', () => {
    isAllowedNavigation.mockReturnValue(true)
    expect(() =>
      assertTrustedSender(eventWithFrame({ parent: {}, url: 'file:///index.html' }))
    ).toThrow(expect.objectContaining({ category: 'authorization' }))
  })

  it('rejects a main frame whose origin is not on the trusted allow-list', () => {
    isAllowedNavigation.mockReturnValue(false)
    expect(() =>
      assertTrustedSender(eventWithFrame({ parent: null, url: 'https://evil.example/' }))
    ).toThrow(expect.objectContaining({ category: 'authorization' }))
  })
})
