import { describe, expect, it } from 'vitest'
import { decideUpdateSigning, readUpdaterPublisherNames } from './updateSigning'

const HTTPS_FEED = new URL('https://updates.company.test/pos/')
const LOOPBACK_TEST_FEED = new URL('http://127.0.0.1:40767/')

describe('readUpdaterPublisherNames', () => {
  it('reads nothing from an unsigned build (no publisherName) or no file', () => {
    const unsigned =
      'provider: generic\nurl: https://example.com/auto-updates\nupdaterCacheDirName: pos-desktop-updater\n'
    expect(readUpdaterPublisherNames(unsigned)).toEqual([])
    expect(readUpdaterPublisherNames(null)).toEqual([])
  })

  it('reads the file electron-builder 26 writes when a publisher is configured', () => {
    // Verbatim resources/app-update.yml of an NSIS build with win.signtoolOptions.publisherName set.
    const written =
      'provider: generic\nurl: https://example.com/auto-updates\nupdaterCacheDirName: pos-desktop-updater\npublisherName:\n  - Thinis POS Internal Test Publisher\n'
    expect(readUpdaterPublisherNames(written)).toEqual(['Thinis POS Internal Test Publisher'])
  })

  it('reads a block list, a scalar, a quoted scalar and an inline list', () => {
    expect(
      readUpdaterPublisherNames(
        "provider: generic\npublisherName:\n  - Company Ltd\n  - 'Company Holdings'\nupdaterCacheDirName: x\n"
      )
    ).toEqual(['Company Ltd', 'Company Holdings'])
    expect(readUpdaterPublisherNames('publisherName: Company Ltd\r\n')).toEqual(['Company Ltd'])
    expect(readUpdaterPublisherNames('publisherName: "Company Ltd"\n')).toEqual(['Company Ltd'])
    expect(readUpdaterPublisherNames('publisherName: [Company Ltd, "Other"]\n')).toEqual([
      'Company Ltd',
      'Other'
    ])
  })
})

describe('decideUpdateSigning', () => {
  it('requires the publisher signature check on Windows', () => {
    expect(
      decideUpdateSigning({ platform: 'win32', feed: HTTPS_FEED, publisherNames: ['Company Ltd'] })
    ).toEqual({ allowed: true, verification: 'publisher_signature' })
  })

  it('refuses automatic updates for an unsigned Windows build on a real feed', () => {
    expect(
      decideUpdateSigning({ platform: 'win32', feed: HTTPS_FEED, publisherNames: [] })
    ).toEqual({ allowed: false, reason: 'UNSIGNED_BUILD' })
  })

  it('allows an unsigned internal test build only on its loopback test feed, labelled checksum-only', () => {
    expect(
      decideUpdateSigning({ platform: 'win32', feed: LOOPBACK_TEST_FEED, publisherNames: [] })
    ).toEqual({ allowed: true, verification: 'checksum_only_test_build' })
  })

  it('reports other platforms (no publisher check in their updater) as checksum-only', () => {
    expect(
      decideUpdateSigning({ platform: 'linux', feed: HTTPS_FEED, publisherNames: [] })
    ).toEqual({ allowed: true, verification: 'checksum_only' })
  })
})
