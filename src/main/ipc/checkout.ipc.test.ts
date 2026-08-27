import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import type { ApplicationServices } from '../app/applicationServices'
import type { CheckoutPreviewService } from '../services/checkoutPreview.service'

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

import { registerCheckoutIpcHandlers } from './checkout.ipc'

const CATALOG_REVISION = 'a'.repeat(64)

function validIntent(): unknown {
  return {
    draftRevision: 1,
    catalogRevision: CATALOG_REVISION,
    items: [
      {
        id: 'item-1',
        productUuid: '00000000-0000-4000-8000-000000000001',
        quantity: '1.000',
        discountType: null,
        discountValue: 0
      }
    ],
    invoiceDiscount: { discountType: null, discountValue: 0 },
    customerUuid: null,
    payments: [
      {
        id: 'payment-1',
        paymentMethodUuid: '00000000-0000-4000-8000-000000000002',
        amount: 1000,
        reference: null
      }
    ]
  }
}

function fakeEvent(): IpcMainInvokeEvent {
  return {} as IpcMainInvokeEvent
}

describe('checkout IPC', () => {
  it('checks the sender before parsing the payload', async () => {
    assertTrustedSender.mockImplementation(() => {
      throw { category: 'authorization', message: 'untrusted', retryable: false }
    })
    const validate = vi.fn()

    handlers.clear()
    registerCheckoutIpcHandlers({
      checkoutPreview: { validate } as unknown as CheckoutPreviewService
    } as ApplicationServices)

    const handler = handlers.get(IPC_CHANNELS.checkoutValidate)
    expect(handler).toBeDefined()

    // Even a payload that would fail schema validation on its own must still be rejected for the
    // sender check first, proving the ordering — not merely that both checks exist.
    const result = await handler?.(fakeEvent(), { not: 'a valid intent' })

    expect(result).toMatchObject({ ok: false, error: { category: 'authorization' } })
    expect(validate).not.toHaveBeenCalled()
  })

  it('parses the payload and calls the preview service once the sender is trusted', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const validate = vi.fn(() => ({
      outcome: 'refresh-required' as const,
      draftRevision: 1
    }))

    handlers.clear()
    registerCheckoutIpcHandlers({
      checkoutPreview: { validate } as unknown as CheckoutPreviewService
    } as ApplicationServices)

    const handler = handlers.get(IPC_CHANNELS.checkoutValidate)
    const result = await handler?.(fakeEvent(), validIntent())

    expect(validate).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: true, data: { outcome: 'refresh-required', draftRevision: 1 } })
  })

  it('rejects a payload with an unrecognized key even from a trusted sender', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const validate = vi.fn()

    handlers.clear()
    registerCheckoutIpcHandlers({
      checkoutPreview: { validate } as unknown as CheckoutPreviewService
    } as ApplicationServices)

    const handler = handlers.get(IPC_CHANNELS.checkoutValidate)
    const intent = validIntent() as Record<string, unknown>
    const result = await handler?.(fakeEvent(), { ...intent, unitPriceAmount: 1000 })

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
    expect(validate).not.toHaveBeenCalled()
  })
})
