import { describe, expect, it, vi, type Mock } from 'vitest'
import { createPublicError } from '../http/apiError'
import { isReceiptSnapshotUploadDue } from '../repositories/receiptSnapshot.repository'
import { ReceiptSnapshotUploadService } from './receiptSnapshotUpload.service'
import type { PublicAppError } from '@shared/contracts/api.contract'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const INVOICE = '44444444-4444-4444-8444-444444444444'
const SHA = 'a'.repeat(64)
const CANONICAL =
  '{"context":{"x":1},"qr":{"payload":"p","type":"txn-ref-v1"},"snapshot_version":1,"template_version":1}'
const NOW = new Date('2026-10-04T10:00:00Z')

function service(options: {
  answer?: () => Promise<{ code: string; data: unknown }>
  capability?: number | null
  contextKey?: () => string | null
}): {
  uploads: ReceiptSnapshotUploadService
  repository: Record<
    'findDueUploads' | 'markAccepted' | 'markRejected' | 'recordUnsettledAttempt',
    Mock
  >
  apiClient: { requestWithMeta: Mock }
} {
  const repository = {
    findDueUploads: vi.fn(() => [
      {
        invoiceLocalUuid: INVOICE,
        companyUuid: COMPANY,
        qrPayload: 'p',
        canonicalContent: CANONICAL,
        contentSha256: SHA,
        attempts: 0
      }
    ]),
    markAccepted: vi.fn(),
    markRejected: vi.fn(),
    recordUnsettledAttempt: vi.fn()
  }
  const apiClient = {
    requestWithMeta: vi.fn(
      options.answer ??
        (async () => ({
          code: 'RECEIPT_SNAPSHOT_STORED',
          data: {
            local_invoice_uuid: INVOICE,
            snapshot_version: 1,
            template_version: 1,
            content_sha256: SHA,
            received_at: 'x'
          }
        }))
    )
  }
  const uploads = new ReceiptSnapshotUploadService({
    repository,
    capabilities: {
      getCapabilityVersion: () => (options.capability === undefined ? 1 : options.capability)
    },
    apiClient: apiClient as never,
    contextKey: options.contextKey ?? (() => `${COMPANY}|device|user|1`),
    now: () => NOW
  })
  return { uploads, repository, apiClient }
}

const refusal = (
  backendCode: string,
  httpStatus: number,
  category: 'validation' | 'conflict' | 'transport' | 'authentication' = 'conflict'
): PublicAppError =>
  createPublicError(category, 'refused', false, { backendCode: backendCode as never, httpStatus })

describe('receipt snapshot uploads', () => {
  it('sends the stored canonical bytes and marks accepted only when the server confirms our hash', async () => {
    const { uploads, repository, apiClient } = service({})
    await uploads.sweep()

    const [, body, options] = apiClient.requestWithMeta.mock.calls[0] as unknown as [
      unknown,
      unknown,
      unknown
    ]
    expect(JSON.stringify(body)).toBe(CANONICAL)
    expect(options).toEqual({ reportOutcome: false })
    expect(repository.findDueUploads).toHaveBeenCalledWith(COMPANY, NOW, 50)
    expect(repository.markAccepted).toHaveBeenCalledWith(INVOICE, NOW.toISOString())
  })

  it('an identical replay answer (already stored) is accepted too', async () => {
    const { uploads, repository } = service({
      answer: async () => ({
        code: 'RECEIPT_SNAPSHOT_ALREADY_STORED',
        data: {
          local_invoice_uuid: INVOICE,
          snapshot_version: 1,
          template_version: 1,
          content_sha256: SHA,
          received_at: 'x'
        }
      })
    })
    await uploads.sweep()
    expect(repository.markAccepted).toHaveBeenCalledTimes(1)
  })

  it('a success that names another hash is never accepted; it is a counted retry', async () => {
    const { uploads, repository } = service({
      answer: async () => ({
        code: 'RECEIPT_SNAPSHOT_STORED',
        data: {
          local_invoice_uuid: INVOICE,
          snapshot_version: 1,
          template_version: 1,
          content_sha256: 'b'.repeat(64),
          received_at: 'x'
        }
      })
    })
    await uploads.sweep()
    expect(repository.markAccepted).not.toHaveBeenCalled()
    expect(repository.recordUnsettledAttempt).toHaveBeenCalledWith(
      INVOICE,
      'unconfirmed_success',
      true,
      NOW.toISOString()
    )
  })

  it.each([
    ['RECEIPT_SNAPSHOT_INVALID', 422, 'validation'],
    ['RECEIPT_SNAPSHOT_CONFLICT', 409, 'conflict']
  ] as const)('%s rejects the snapshot for good', async (code, status, category) => {
    const { uploads, repository } = service({
      answer: async () => {
        throw refusal(code, status, category)
      }
    })
    await uploads.sweep()
    expect(repository.markRejected).toHaveBeenCalledWith(INVOICE, code, NOW.toISOString())
    expect(repository.recordUnsettledAttempt).not.toHaveBeenCalled()
  })

  it('INVOICE_NOT_UPLOADED and server errors are counted retries; no answer only spaces the next try', async () => {
    const notUploaded = service({
      answer: async () => {
        throw refusal('INVOICE_NOT_UPLOADED', 409)
      }
    })
    await notUploaded.uploads.sweep()
    expect(notUploaded.repository.recordUnsettledAttempt).toHaveBeenCalledWith(
      INVOICE,
      'INVOICE_NOT_UPLOADED',
      true,
      NOW.toISOString()
    )

    const serverError = service({
      answer: async () => {
        // As the client parses an error envelope: a backend code and trace id, no HTTP status.
        throw createPublicError('transport', 'server error', true, {
          backendCode: 'SERVER_ERROR',
          traceId: 'trace-1'
        })
      }
    })
    await serverError.uploads.sweep()
    expect(serverError.repository.recordUnsettledAttempt).toHaveBeenCalledWith(
      INVOICE,
      'SERVER_ERROR',
      true,
      NOW.toISOString()
    )

    const offline = service({
      answer: async () => {
        throw createPublicError('transport', 'offline', true)
      }
    })
    await offline.uploads.sweep()
    expect(offline.repository.recordUnsettledAttempt).toHaveBeenCalledWith(
      INVOICE,
      'no_answer',
      false,
      NOW.toISOString()
    )
  })

  it('an access refusal stops the sweep and changes nothing', async () => {
    const { uploads, repository } = service({
      answer: async () => {
        throw refusal('SESSION_REVOKED', 401, 'authentication')
      }
    })
    await uploads.sweep()
    expect(repository.markRejected).not.toHaveBeenCalled()
    expect(repository.recordUnsettledAttempt).not.toHaveBeenCalled()
  })

  it('sends nothing while the server does not advertise snapshot v1, or nobody is signed in', async () => {
    for (const options of [{ capability: null }, { capability: 2 }, { contextKey: () => null }]) {
      const { uploads, apiClient } = service(options)
      await uploads.sweep()
      expect(apiClient.requestWithMeta).not.toHaveBeenCalled()
    }
  })

  it('a session change during the request discards the answer', async () => {
    let key: string | null = `${COMPANY}|device|user|1`
    const { uploads, repository } = service({
      contextKey: () => key,
      answer: async () => {
        key = `${COMPANY}|device|other|2`
        return { code: 'RECEIPT_SNAPSHOT_STORED', data: {} }
      }
    })
    await uploads.sweep()
    expect(repository.markAccepted).not.toHaveBeenCalled()
    expect(repository.recordUnsettledAttempt).not.toHaveBeenCalled()
  })
})

describe('receipt snapshot retry spacing', () => {
  const at = (ms: number): Date => new Date(Date.parse('2026-10-04T10:00:00.000Z') + ms)
  it('is due at once until answered, then 1 minute, 5 minutes and onwards, bounded', () => {
    expect(isReceiptSnapshotUploadDue(0, null, at(0))).toBe(true)
    expect(isReceiptSnapshotUploadDue(0, '2026-10-04T10:00:00.000Z', at(0))).toBe(true)
    expect(isReceiptSnapshotUploadDue(1, '2026-10-04T10:00:00.000Z', at(59_999))).toBe(false)
    expect(isReceiptSnapshotUploadDue(1, '2026-10-04T10:00:00.000Z', at(60_000))).toBe(true)
    expect(isReceiptSnapshotUploadDue(2, '2026-10-04T10:00:00.000Z', at(299_999))).toBe(false)
    expect(isReceiptSnapshotUploadDue(8, '2026-10-04T10:00:00.000Z', at(1e12))).toBe(false)
  })
  it('respects a stamp moved ahead by a clock change, unless it is more than a day ahead', () => {
    expect(isReceiptSnapshotUploadDue(1, '2026-10-04T10:00:00.000Z', at(-3_600_000))).toBe(false)
    expect(isReceiptSnapshotUploadDue(1, '2026-10-04T10:00:00.000Z', at(-86_400_001))).toBe(true)
  })
})
