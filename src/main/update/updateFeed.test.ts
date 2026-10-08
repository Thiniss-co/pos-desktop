import { describe, expect, it } from 'vitest'
import { resolveUpdateFeed } from './updateFeed'

describe('update feed', () => {
  it('is not configured without a URL (no default feed)', () => {
    expect(resolveUpdateFeed({})).toBeNull()
  })

  it('accepts an https feed', () => {
    expect(
      resolveUpdateFeed({ MAIN_VITE_POS_UPDATE_FEED_URL: 'https://updates.example.test/pos/' })
        ?.href
    ).toBe('https://updates.example.test/pos/')
  })

  it('refuses plain http, credentials and query strings', () => {
    for (const url of [
      'http://updates.example.test/pos/',
      'https://user:secret@updates.example.test/',
      'https://updates.example.test/?token=x',
      'not a url'
    ]) {
      expect(resolveUpdateFeed({ MAIN_VITE_POS_UPDATE_FEED_URL: url })).toBeNull()
    }
  })

  it('accepts a loopback http feed only in a test package built with the opt-in', () => {
    const feed = { MAIN_VITE_POS_UPDATE_FEED_URL: 'http://127.0.0.1:47000/feed/' }

    expect(resolveUpdateFeed(feed)).toBeNull()
    expect(resolveUpdateFeed({ ...feed, MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN: 'true' })?.href).toBe(
      'http://127.0.0.1:47000/feed/'
    )
  })
})
