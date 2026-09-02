import { describe, expect, it, vi, type Mock } from 'vitest'
import { DESKTOP_API_ROUTES } from '@shared/constants/apiRoutes'
import {
  parseFrozenUploadPayload,
  uploadInvoice,
  type InvoiceUploadApiClient
} from './invoiceUpload.client'

const invoiceResource = {
  id: '99999992-9999-4999-8999-000000000001',
  server_number: 'POS-20260101-000042',
  offline_number: 'POS-333333-20260101-000001',
  status: 'completed',
  payment_status: 'paid',
  currency: 'EGP',
  subtotal_amount: 1000,
  discount_total_amount: 0,
  tax_total_amount: 0,
  grand_total_amount: 1000,
  paid_total_amount: 1000,
  change_due_amount: 0,
  due_amount: 0,
  sold_at: '2026-01-01T02:00:00+00:00',
  items: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      product_uuid: '66666666-6666-4666-8666-666666666666',
      quantity: '2.000',
      total_amount: 1000
    }
  ],
  payments: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      type: 'cash',
      amount: 1000,
      reference: null
    }
  ]
}

const payloadJson = JSON.stringify({
  idempotency_key: '99999992-9999-4999-8999-000000000001',
  local_invoice_uuid: '99999992-9999-4999-8999-000000000001',
  client_contract_version: 2,
  shift_uuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
})

type FakeUploadClient = InvoiceUploadApiClient & { readonly requestWithMeta: Mock }

function clientAnswering(
  code: string,
  data: unknown = invoiceResource,
  meta: Record<string, unknown> = { trace_id: 'trace-1' }
): FakeUploadClient {
  // vi.fn() cannot express the generic requestWithMeta signature, so the double is asserted into
  // the narrow interface. The shape it resolves is the real envelope shape, field for field.
  return {
    requestWithMeta: vi.fn().mockResolvedValue({ data, meta, code, message: 'ok' })
  } as unknown as FakeUploadClient
}

describe('uploadInvoice', () => {
  it('reports a fresh commit as created', async () => {
    const apiClient = clientAnswering('DESKTOP_INVOICE_UPLOADED')

    await expect(uploadInvoice(apiClient, payloadJson)).resolves.toMatchObject({
      kind: 'created',
      invoice: { id: invoiceResource.id, server_number: 'POS-20260101-000042' },
      traceId: 'trace-1'
    })
  })

  it('reports an idempotent replay as duplicate rather than as a failure', async () => {
    // The lost-acknowledgment path. It is a success: the server holds exactly one invoice for this
    // key, so the queue row must reach `synced` here just as it does on 201.
    const apiClient = clientAnswering('DESKTOP_INVOICE_ALREADY_UPLOADED')

    await expect(uploadInvoice(apiClient, payloadJson)).resolves.toMatchObject({
      kind: 'duplicate',
      invoice: { id: invoiceResource.id }
    })
  })

  it('sends the frozen queued payload verbatim to the desktop upload route', async () => {
    const apiClient = clientAnswering('DESKTOP_INVOICE_UPLOADED')

    await uploadInvoice(apiClient, payloadJson)

    expect(apiClient.requestWithMeta).toHaveBeenCalledTimes(1)
    expect(apiClient.requestWithMeta).toHaveBeenCalledWith(
      DESKTOP_API_ROUTES.invoicesUpload,
      JSON.parse(payloadJson)
    )
    expect(DESKTOP_API_ROUTES.invoicesUpload.path).toBe('/invoices/upload')
  })

  it('omits traceId when the envelope carries none', async () => {
    const apiClient = clientAnswering('DESKTOP_INVOICE_UPLOADED', invoiceResource, {})

    await expect(uploadInvoice(apiClient, payloadJson)).resolves.not.toHaveProperty('traceId')
  })

  it('treats an unrecognized success code as a non-retryable contract error', async () => {
    const apiClient = clientAnswering('DESKTOP_INVOICE_PARTIALLY_UPLOADED')

    await expect(uploadInvoice(apiClient, payloadJson)).rejects.toMatchObject({
      category: 'unexpected',
      retryable: false,
      backendCode: 'upload_success_code_unrecognized'
    })
  })

  it('rejects a success body that does not match the contract', async () => {
    const apiClient = clientAnswering('DESKTOP_INVOICE_UPLOADED', {
      ...invoiceResource,
      id: 'not-a-uuid'
    })

    await expect(uploadInvoice(apiClient, payloadJson)).rejects.toMatchObject({
      category: 'unexpected',
      retryable: false,
      backendCode: 'upload_response_invalid'
    })
  })

  it('accepts a response whose relations were not eager-loaded', async () => {
    const { items, payments, ...withoutRelations } = invoiceResource
    void items
    void payments
    const apiClient = clientAnswering('DESKTOP_INVOICE_UPLOADED', withoutRelations)

    await expect(uploadInvoice(apiClient, payloadJson)).resolves.toMatchObject({ kind: 'created' })
  })

  it('tolerates unknown server fields instead of failing an accepted invoice', async () => {
    const apiClient = clientAnswering('DESKTOP_INVOICE_UPLOADED', {
      ...invoiceResource,
      a_field_added_next_year: true
    })

    await expect(uploadInvoice(apiClient, payloadJson)).resolves.toMatchObject({ kind: 'created' })
  })

  it('never dispatches when the queued payload is unusable', async () => {
    const apiClient = clientAnswering('DESKTOP_INVOICE_UPLOADED')

    await expect(uploadInvoice(apiClient, '{ not json')).rejects.toMatchObject({
      backendCode: 'upload_payload_not_json'
    })
    expect(apiClient.requestWithMeta).not.toHaveBeenCalled()
  })
})

describe('parseFrozenUploadPayload', () => {
  it('returns the queued object unchanged', () => {
    expect(parseFrozenUploadPayload(payloadJson)).toEqual(JSON.parse(payloadJson))
  })

  it.each(['[]', '"a string"', '42', 'null'])('rejects non-object payload %s', (json) => {
    expect(() => parseFrozenUploadPayload(json)).toThrow()
    try {
      parseFrozenUploadPayload(json)
    } catch (error) {
      expect(error).toMatchObject({ retryable: false, backendCode: 'upload_payload_not_object' })
    }
  })
})
