import { describe, expect, it, vi } from 'vitest'
import { CommercialAccessPublisher } from '../ipc/license.ipc'
import { DesktopApiClient } from '../http/desktopApiClient'
import { payloadHash } from '../services/localSale.fingerprint'
import { uploadInvoice } from './invoiceUpload.client'
import { subscribeInvoiceUploadTriggers } from './invoiceUploadTriggers'
import { InvoiceUploadWorker } from './invoiceUploadWorker'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() }
}))

const COMPANY = '11111111-1111-4111-8111-111111111111'
const DEVICE = '33333333-3333-4333-8333-333333333333'
const INVOICE = '00000000-0000-4000-8000-000000000002'
const ALLOWED = {
  allowed: true,
  reason: null,
  warning: null,
  retryable: false,
  evaluatedAt: null,
  nextValidationDueAt: null,
  restrictionLevel: null,
  warningMessage: null
}

function successBody(): unknown {
  return {
    success: true,
    message: 'Desktop invoice uploaded successfully.',
    code: 'DESKTOP_INVOICE_UPLOADED',
    data: {
      id: '55555555-5555-4555-8555-555555555555',
      server_number: 'POS-20260903-000001'
    },
    meta: { trace_id: 'trace-cp3g5' }
  }
}

/**
 * CP-3G-5D — the real access publisher, the real trigger wiring, the real worker, the real upload
 * client and the real `DesktopApiClient`, with only the transport counted.
 *
 * This is the arm the Electron real-SQLite suite cannot carry: `CommercialAccessPublisher.publish()`
 * reaches `BrowserWindow`, which does not exist under `ELECTRON_RUN_AS_NODE`. Here the electron
 * module is mocked to an empty window list, so the **real** publisher runs and the assertion is
 * about how many HTTP requests a publication storm can produce.
 */
describe('CP-3G-5D — dispatch cardinality through the production trigger', () => {
  function build(): {
    readonly worker: InvoiceUploadWorker
    readonly publisher: CommercialAccessPublisher
    readonly requests: { url: string; method: string; body: string }[]
    readonly claimable: { value: number }
    readonly dispose: () => void
  } {
    const requests: { url: string; method: string; body: string }[] = []
    const claimable = { value: 1 }
    const payloadJson = JSON.stringify({ idempotency_key: INVOICE, local_invoice_uuid: INVOICE })
    const hash = payloadHash(JSON.parse(payloadJson))

    const fetchImplementation = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : ''
      })

      return new Response(JSON.stringify(successBody()), {
        status: 201,
        headers: { 'content-type': 'application/json' }
      })
    }) as typeof fetch

    const apiClient = new DesktopApiClient({
      apiOrigin: new URL('https://backend.invalid'),
      getAccessToken: () => 'test-token',
      getDeviceUuid: () => DEVICE,
      fetchImplementation
    })

    const worker = new InvoiceUploadWorker({
      syncQueue: {
        reclaimExpiredUploadLeases: () => [],
        releaseDueRetries: () => [],
        claimNextInvoiceUpload: () => {
          if (claimable.value <= 0) {
            return null
          }

          claimable.value -= 1

          return {
            localQueueUuid: '00000000-0000-4000-8000-000000000001',
            invoiceLocalUuid: INVOICE,
            payloadJson,
            payloadHash: hash,
            idempotencyKey: INVOICE,
            attemptCount: 1
          }
        },
        countForeignPendingUploads: () => 0,
        getStatus: () => ({
          state: 'idle',
          pausedReason: null,
          pending: 0,
          uploading: 0,
          retryable: 0,
          conflict: 0,
          rejected: 0
        })
      } as never,
      recorder: { record: () => {} } as never,
      commercialAccess: { assertAllowed: () => {} },
      permissions: { hasPermission: () => true },
      session: {
        getContext: () => ({
          isAuthenticated: true,
          companyUuid: COMPANY,
          deviceUuid: DEVICE
        })
      },
      upload: (payload) => uploadInvoice(apiClient, payload),
      schedule: () => () => undefined
    })

    const publisher = new CommercialAccessPublisher({
      describe: () => ({
        sell: { ...ALLOWED, action: 'sell' as const },
        sync: { ...ALLOWED, action: 'sync' as const }
      })
    })

    const dispose = subscribeInvoiceUploadTriggers({ accessPublisher: publisher, worker })

    return { worker, publisher, requests, claimable, dispose }
  }

  it('turns a storm of real access publications into exactly one outbound request', async () => {
    const context = build()

    // Six real publications through the production publisher, overlapping one in-flight drain.
    const inFlight = context.worker.run()
    context.publisher.publishCurrent()
    context.publisher.publishCurrent()
    context.publisher.publishCurrent()
    await inFlight
    context.publisher.publishCurrent()
    context.publisher.publishCurrent()
    await context.worker.run()

    expect(context.requests).toHaveLength(1)
    expect(context.requests[0]?.method).toBe('POST')
    expect(new URL(context.requests[0]!.url).pathname).toBe('/api/v1/desktop/invoices/upload')
    expect(JSON.parse(context.requests[0]!.body).idempotency_key).toBe(INVOICE)

    context.dispose()
  })

  it('sends nothing once the queue holds no claimable row', async () => {
    const context = build()

    context.claimable.value = 0
    context.publisher.publishCurrent()
    await context.worker.run()
    context.publisher.publishCurrent()
    await context.worker.run()

    expect(context.requests).toHaveLength(0)

    context.dispose()
  })

  it('stops dispatching after the subscription is disposed', async () => {
    const context = build()

    context.dispose()
    context.publisher.publishCurrent()
    await context.worker.run()

    // The drain still runs when called directly — but the trigger no longer calls it.
    expect(context.requests).toHaveLength(1)

    const before = context.requests.length
    context.publisher.publishCurrent()
    context.publisher.publishCurrent()

    expect(context.requests).toHaveLength(before)
  })
})
