import { describe, expect, it, vi } from 'vitest'
import { InvoiceUploadFailureReader } from './invoiceUploadFailures'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const DEVICE = '33333333-3333-4333-8333-333333333333'
const EMPTY = { items: [], nextCursor: null }

function build(context: {
  isAuthenticated: boolean
  companyUuid: string | null
  deviceUuid: string | null
}): {
  readonly reader: InvoiceUploadFailureReader
  readonly listUploadFailures: ReturnType<typeof vi.fn>
} {
  const listUploadFailures = vi.fn(() => EMPTY)
  const reader = new InvoiceUploadFailureReader({
    syncQueue: { listUploadFailures } as never,
    session: { getContext: () => context }
  })

  return { reader, listUploadFailures }
}

describe('InvoiceUploadFailureReader', () => {
  it('scopes every read to the main-process session owner', () => {
    const { reader, listUploadFailures } = build({
      isAuthenticated: true,
      companyUuid: COMPANY,
      deviceUuid: DEVICE
    })

    reader.list()

    // The owner is derived here and is not a parameter any caller — least of all the renderer —
    // can supply or override.
    expect(listUploadFailures).toHaveBeenCalledWith(
      { companyUuid: COMPANY, deviceUuid: DEVICE },
      null,
      25
    )
  })

  it('forwards only the cursor and the bounded page size', () => {
    const { reader, listUploadFailures } = build({
      isAuthenticated: true,
      companyUuid: COMPANY,
      deviceUuid: DEVICE
    })
    const cursor = {
      createdAt: '2026-09-03T10:00:00.000Z',
      localQueueUuid: '00000000-0000-4000-8000-000000000001'
    }

    reader.list(cursor, 10)

    expect(listUploadFailures).toHaveBeenCalledWith(
      { companyUuid: COMPANY, deviceUuid: DEVICE },
      cursor,
      10
    )
  })

  it.each([
    ['unauthenticated', { isAuthenticated: false, companyUuid: COMPANY, deviceUuid: DEVICE }],
    ['no company', { isAuthenticated: true, companyUuid: null, deviceUuid: DEVICE }],
    ['no device', { isAuthenticated: true, companyUuid: COMPANY, deviceUuid: null }]
  ])('returns an empty page and never queries when the session is %s', (_label, context) => {
    const { reader, listUploadFailures } = build(context)

    // Fail closed: without a resolved owner there is nothing this device may show, so the answer
    // is "nothing" rather than an unscoped query.
    expect(reader.list()).toEqual(EMPTY)
    expect(listUploadFailures).not.toHaveBeenCalled()
  })
})
