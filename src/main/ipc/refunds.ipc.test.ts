import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import type { ApplicationServices } from '../app/applicationServices'
import type { RefundService } from '../services/refund.service'
import type { LocalRefundRepository } from '../repositories/localRefund.repository'
import type { LocalSaleRepository } from '../repositories/localSale.repository'
import type { ShiftAuthorityService } from '../services/shiftAuthority.service'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown> | unknown
  >()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(
      (
        channel: string,
        handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown> | unknown
      ) => {
        handlers.set(channel, handler)
      }
    )
  }
}))

const { assertTrustedSender } = vi.hoisted(() => ({ assertTrustedSender: vi.fn() }))
vi.mock('./assertTrustedSender', () => ({ assertTrustedSender }))

import { registerRefundsIpcHandlers } from './refunds.ipc'

function fakeEvent(): IpcMainInvokeEvent {
  return {} as IpcMainInvokeEvent
}

const UUID_A = '00000000-0000-4000-8000-000000000001'
const UUID_B = '00000000-0000-4000-8000-000000000002'

function validSubmitIntent(): unknown {
  return {
    previewId: UUID_A,
    invoiceLocalUuid: 'invoice-local',
    lines: [{ invoiceItemRemoteUuid: UUID_B, quantityMilli: 1000 }],
    stockReturned: true,
    paymentMethodUuid: null
  }
}

function buildServices(overrides: Partial<ApplicationServices> = {}): ApplicationServices {
  return {
    refunds: {
      getRefundableInvoice: vi.fn(),
      previewRefund: vi.fn(),
      submitRefund: vi.fn(),
      resumeRefund: vi.fn(),
      cancelPreparedRefund: vi.fn(() => true)
    } as unknown as RefundService,
    localRefunds: {
      findOpenForInvoice: vi.fn(() => null),
      refundsForInvoice: vi.fn(() => [])
    } as unknown as LocalRefundRepository,
    localSaleRepository: {
      listInvoices: vi.fn(() => ({ rows: [], nextCursor: null })),
      findInvoiceByLocalUuid: vi.fn(() => null),
      itemsForInvoice: vi.fn(() => []),
      paymentsForInvoice: vi.fn(() => [])
    } as unknown as LocalSaleRepository,
    shiftAuthority: {
      captureContext: vi.fn(() => ({
        companyUuid: UUID_A,
        deviceUuid: UUID_A,
        userUuid: UUID_A,
        sessionEpoch: 1
      }))
    } as unknown as ShiftAuthorityService,
    ...overrides
  } as ApplicationServices
}

describe('refunds IPC', () => {
  it('checks the sender before parsing the submit payload', async () => {
    assertTrustedSender.mockImplementation(() => {
      throw { category: 'authorization', message: 'untrusted', retryable: false }
    })

    const services = buildServices()
    handlers.clear()
    registerRefundsIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.refundsSubmit)
    const result = await handler?.(fakeEvent(), { not: 'valid' })

    expect(result).toMatchObject({ ok: false, error: { category: 'authorization' } })
    expect(services.refunds.submitRefund).not.toHaveBeenCalled()
  })

  it('rejects a submit payload missing stockReturned -- never defaulted', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    handlers.clear()
    registerRefundsIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.refundsSubmit)
    const payload = validSubmitIntent() as Record<string, unknown>
    delete payload.stockReturned

    const result = await handler?.(fakeEvent(), payload)

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
    expect(services.refunds.submitRefund).not.toHaveBeenCalled()
  })

  it('rejects a submit payload with an unrecognized key even from a trusted sender', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    handlers.clear()
    registerRefundsIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.refundsSubmit)
    const result = await handler?.(fakeEvent(), {
      ...(validSubmitIntent() as object),
      grandTotalAmount: 999
    })

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
    expect(services.refunds.submitRefund).not.toHaveBeenCalled()
  })

  it('parses a valid submit payload and calls the refund service once the sender is trusted', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    ;(services.refunds.submitRefund as ReturnType<typeof vi.fn>).mockResolvedValue({
      localRefundUuid: UUID_A,
      state: 'accepted',
      remoteUuid: UUID_B,
      refundNumber: 'REF-0001',
      errorCode: null
    })

    handlers.clear()
    registerRefundsIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.refundsSubmit)
    const result = await handler?.(fakeEvent(), validSubmitIntent())

    expect(services.refunds.submitRefund).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, data: { state: 'accepted' } })
  })

  it('rejects a preview payload with an empty lines array', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    handlers.clear()
    registerRefundsIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.refundsPreview)
    const result = await handler?.(fakeEvent(), {
      invoiceLocalUuid: 'invoice-local',
      lines: [],
      stockReturned: true
    })

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
    expect(services.refunds.previewRefund).not.toHaveBeenCalled()
  })

  it('calls resumeRefund with just the local refund uuid', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    ;(services.refunds.resumeRefund as ReturnType<typeof vi.fn>).mockResolvedValue({
      localRefundUuid: UUID_A,
      state: 'unresolved',
      remoteUuid: null,
      refundNumber: null,
      errorCode: null
    })

    handlers.clear()
    registerRefundsIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.refundsResume)
    const result = await handler?.(fakeEvent(), { localRefundUuid: UUID_A })

    expect(services.refunds.resumeRefund).toHaveBeenCalledWith(UUID_A)
    expect(result).toMatchObject({ ok: true, data: { state: 'unresolved' } })
  })

  it('calls cancelPreparedRefund and returns its boolean result', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    handlers.clear()
    registerRefundsIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.refundsCancelPrepared)
    const result = await handler?.(fakeEvent(), { localRefundUuid: UUID_A })

    expect(services.refunds.cancelPreparedRefund).toHaveBeenCalledWith(UUID_A)
    expect(result).toEqual({ ok: true, data: { cancelled: true } })
  })

  it('rejects an item uuid selection that is not a valid uuid', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const services = buildServices()
    handlers.clear()
    registerRefundsIpcHandlers(services)

    const handler = handlers.get(IPC_CHANNELS.refundsPreview)
    const result = await handler?.(fakeEvent(), {
      invoiceLocalUuid: 'invoice-local',
      lines: [{ invoiceItemRemoteUuid: 'not-a-uuid', quantityMilli: 1000 }],
      stockReturned: true
    })

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
  })
})
