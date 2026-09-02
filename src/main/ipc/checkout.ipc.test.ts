import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import type { ApplicationServices } from '../app/applicationServices'
import type { CheckoutPreviewService } from '../services/checkoutPreview.service'
import type { LocalSaleService } from '../services/localSale.service'
import type { SaleCompletionService } from '../services/saleCompletion.service'

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

const ATTEMPT_KEY = '00000000-0000-4000-8000-0000000000aa'

/**
 * `complete`/`retry` are served by `SaleCompletionService` (CP-5D) and the remaining write/read
 * channels by `LocalSaleService`. The same stub record backs both so every existing expectation
 * stays about the channel's behaviour rather than about which collaborator holds the method.
 */
function registerWithLocalSale(localSale: Record<string, unknown>): void {
  handlers.clear()
  registerCheckoutIpcHandlers({
    checkoutPreview: { validate: vi.fn() } as unknown as CheckoutPreviewService,
    localSale: localSale as unknown as LocalSaleService,
    saleCompletion: localSale as unknown as SaleCompletionService
  } as ApplicationServices)
}

describe('checkout completion routing', () => {
  it('serves complete/retry from the acquisition-aware completion service, never the raw writer', async () => {
    handlers.clear()
    const localSaleComplete = vi.fn()
    const localSaleRetry = vi.fn()
    const completionComplete = vi
      .fn()
      .mockResolvedValue({ outcome: 'abandoned', attemptKey: ATTEMPT_KEY })
    const completionRetry = vi
      .fn()
      .mockResolvedValue({ outcome: 'abandoned', attemptKey: ATTEMPT_KEY })
    registerCheckoutIpcHandlers({
      checkoutPreview: { validate: vi.fn() } as unknown as CheckoutPreviewService,
      localSale: {
        complete: localSaleComplete,
        retry: localSaleRetry
      } as unknown as LocalSaleService,
      saleCompletion: {
        complete: completionComplete,
        retry: completionRetry
      } as unknown as SaleCompletionService
    } as ApplicationServices)

    await handlers.get(IPC_CHANNELS.checkoutComplete)?.(fakeEvent(), {
      attemptKey: ATTEMPT_KEY,
      intent: validIntent()
    })
    await handlers.get(IPC_CHANNELS.checkoutRetryAttempt)?.(fakeEvent(), {
      attemptKey: ATTEMPT_KEY
    })

    expect(completionComplete).toHaveBeenCalledTimes(1)
    expect(completionRetry).toHaveBeenCalledTimes(1)
    expect(localSaleComplete).not.toHaveBeenCalled()
    expect(localSaleRetry).not.toHaveBeenCalled()
  })
})

describe('checkout:complete', () => {
  it('checks the sender before parsing the payload', async () => {
    assertTrustedSender.mockImplementation(() => {
      throw { category: 'authorization', message: 'untrusted', retryable: false }
    })
    const complete = vi.fn()
    registerWithLocalSale({ complete })

    const handler = handlers.get(IPC_CHANNELS.checkoutComplete)
    const result = await handler?.(fakeEvent(), { not: 'valid' })

    expect(result).toMatchObject({ ok: false, error: { category: 'authorization' } })
    expect(complete).not.toHaveBeenCalled()
  })

  it('rejects a renderer-supplied price/total field even from a trusted sender', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const complete = vi.fn()
    registerWithLocalSale({ complete })

    const handler = handlers.get(IPC_CHANNELS.checkoutComplete)
    const intent = validIntent() as Record<string, unknown>
    const result = await handler?.(fakeEvent(), {
      attemptKey: ATTEMPT_KEY,
      intent: { ...intent, unitPriceAmount: 1000 }
    })

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
    expect(complete).not.toHaveBeenCalled()
  })

  it('parses attemptKey and intent, calls the service once, and passes the outcome through', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const outcome = { outcome: 'committed', attemptKey: ATTEMPT_KEY, replay: false }
    const complete = vi.fn(() => outcome)
    registerWithLocalSale({ complete })

    const handler = handlers.get(IPC_CHANNELS.checkoutComplete)
    const result = await handler?.(fakeEvent(), { attemptKey: ATTEMPT_KEY, intent: validIntent() })

    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledWith(ATTEMPT_KEY, validIntent())
    expect(result).toEqual({ ok: true, data: outcome })
  })

  it('rejects every allocation, ownership, and lifecycle authority field a renderer might add', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const complete = vi.fn()
    registerWithLocalSale({ complete })

    const handler = handlers.get(IPC_CHANNELS.checkoutComplete)
    const intent = validIntent() as Record<string, unknown>
    // CP-5D-A6: none of these may ever be supplied over IPC — main derives all of them.
    const forbidden = [
      'companyUuid',
      'deviceUuid',
      'branchUuid',
      'warehouseUuid',
      'stockItemId',
      'allocationUuid',
      'allocationRevision',
      'allocationStatus',
      'contractVersion',
      'grantedQuantityMilli',
      'sessionEpoch',
      'claimSessionEpoch',
      'commitSessionEpoch'
    ]

    for (const field of forbidden) {
      const inIntent = await handler?.(fakeEvent(), {
        attemptKey: ATTEMPT_KEY,
        intent: { ...intent, [field]: 'injected' }
      })
      const atTopLevel = await handler?.(fakeEvent(), {
        attemptKey: ATTEMPT_KEY,
        intent: validIntent(),
        [field]: 'injected'
      })

      expect(inIntent, field).toMatchObject({ ok: false, error: { category: 'validation' } })
      expect(atTopLevel, field).toMatchObject({ ok: false, error: { category: 'validation' } })
    }

    expect(complete).not.toHaveBeenCalled()
  })

  it('has no bypass parameter: an extra field alongside attemptKey/intent is rejected outright', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const complete = vi.fn()
    registerWithLocalSale({ complete })

    const handler = handlers.get(IPC_CHANNELS.checkoutComplete)
    const result = await handler?.(fakeEvent(), {
      attemptKey: ATTEMPT_KEY,
      intent: validIntent(),
      force: true
    })

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
    expect(complete).not.toHaveBeenCalled()
  })

  it('a blocking claimed attempt refuses a fresh key the same as any other caller — no direct-IPC bypass', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const outcome = {
      outcome: 'failed',
      code: 'attempt-blocked',
      attemptKey: null,
      blockingAttemptKey: ATTEMPT_KEY
    }
    const complete = vi.fn(() => outcome)
    registerWithLocalSale({ complete })

    const handler = handlers.get(IPC_CHANNELS.checkoutComplete)
    const freshKey = '00000000-0000-4000-8000-0000000000bb'
    const result = await handler?.(fakeEvent(), { attemptKey: freshKey, intent: validIntent() })

    expect(complete).toHaveBeenCalledWith(freshKey, validIntent())
    expect(result).toEqual({ ok: true, data: outcome })
  })
})

describe('checkout:retry-attempt', () => {
  it('checks the sender before parsing the payload', async () => {
    assertTrustedSender.mockImplementation(() => {
      throw { category: 'authorization', message: 'untrusted', retryable: false }
    })
    const retry = vi.fn()
    registerWithLocalSale({ retry })

    const handler = handlers.get(IPC_CHANNELS.checkoutRetryAttempt)
    const result = await handler?.(fakeEvent(), { attemptKey: ATTEMPT_KEY })

    expect(result).toMatchObject({ ok: false, error: { category: 'authorization' } })
    expect(retry).not.toHaveBeenCalled()
  })

  it('rejects a malformed (non-uuid) attempt key', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const retry = vi.fn()
    registerWithLocalSale({ retry })

    const handler = handlers.get(IPC_CHANNELS.checkoutRetryAttempt)
    const result = await handler?.(fakeEvent(), { attemptKey: 'not-a-uuid' })

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
    expect(retry).not.toHaveBeenCalled()
  })

  it('is key-only: never accepts or forwards renderer-supplied content', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const outcome = { outcome: 'committed', attemptKey: ATTEMPT_KEY, replay: true }
    const retry = vi.fn(() => outcome)
    registerWithLocalSale({ retry })

    const handler = handlers.get(IPC_CHANNELS.checkoutRetryAttempt)
    const result = await handler?.(fakeEvent(), { attemptKey: ATTEMPT_KEY, intent: validIntent() })

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
    expect(retry).not.toHaveBeenCalled()
  })

  it('calls retry with only the attempt key and passes the outcome through', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const outcome = { outcome: 'failed', code: 'context-changed', attemptKey: ATTEMPT_KEY }
    const retry = vi.fn(() => outcome)
    registerWithLocalSale({ retry })

    const handler = handlers.get(IPC_CHANNELS.checkoutRetryAttempt)
    const result = await handler?.(fakeEvent(), { attemptKey: ATTEMPT_KEY })

    expect(retry).toHaveBeenCalledWith(ATTEMPT_KEY)
    expect(result).toEqual({ ok: true, data: outcome })
  })

  it('a foreign owner’s key is opaquely not-found, never disclosed', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const outcome = { outcome: 'failed', code: 'not-found', attemptKey: null }
    const retry = vi.fn(() => outcome)
    registerWithLocalSale({ retry })

    const handler = handlers.get(IPC_CHANNELS.checkoutRetryAttempt)
    const result = await handler?.(fakeEvent(), { attemptKey: ATTEMPT_KEY })

    expect(result).toEqual({ ok: true, data: outcome })
  })
})

describe('checkout:abandon-attempt', () => {
  it('checks the sender before parsing the payload', async () => {
    assertTrustedSender.mockImplementation(() => {
      throw { category: 'authorization', message: 'untrusted', retryable: false }
    })
    const abandon = vi.fn()
    registerWithLocalSale({ abandon })

    const handler = handlers.get(IPC_CHANNELS.checkoutAbandonAttempt)
    const result = await handler?.(fakeEvent(), { attemptKey: ATTEMPT_KEY })

    expect(result).toMatchObject({ ok: false, error: { category: 'authorization' } })
    expect(abandon).not.toHaveBeenCalled()
  })

  it('calls abandon with only the attempt key and passes the outcome through, foreign owner opaque', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const outcome = { outcome: 'failed', code: 'not-found', attemptKey: null }
    const abandon = vi.fn(() => outcome)
    registerWithLocalSale({ abandon })

    const handler = handlers.get(IPC_CHANNELS.checkoutAbandonAttempt)
    const result = await handler?.(fakeEvent(), { attemptKey: ATTEMPT_KEY })

    expect(abandon).toHaveBeenCalledWith(ATTEMPT_KEY)
    expect(result).toEqual({ ok: true, data: outcome })
  })
})

describe('checkout:acknowledge-attempt', () => {
  it('checks the sender before parsing the payload', async () => {
    assertTrustedSender.mockImplementation(() => {
      throw { category: 'authorization', message: 'untrusted', retryable: false }
    })
    const acknowledge = vi.fn()
    registerWithLocalSale({ acknowledge })

    const handler = handlers.get(IPC_CHANNELS.checkoutAcknowledgeAttempt)
    const result = await handler?.(fakeEvent(), { attemptKey: ATTEMPT_KEY })

    expect(result).toMatchObject({ ok: false, error: { category: 'authorization' } })
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it('is idempotent from the IPC boundary’s perspective: repeats the same call, same passthrough', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const outcome = { outcome: 'acknowledged', attemptKey: ATTEMPT_KEY, replay: true }
    const acknowledge = vi.fn(() => outcome)
    registerWithLocalSale({ acknowledge })

    const handler = handlers.get(IPC_CHANNELS.checkoutAcknowledgeAttempt)
    const first = await handler?.(fakeEvent(), { attemptKey: ATTEMPT_KEY })
    const second = await handler?.(fakeEvent(), { attemptKey: ATTEMPT_KEY })

    expect(acknowledge).toHaveBeenCalledTimes(2)
    expect(first).toEqual({ ok: true, data: outcome })
    expect(second).toEqual({ ok: true, data: outcome })
  })

  it('a foreign owner’s key is opaquely not-found, never disclosed', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const outcome = { outcome: 'failed', code: 'not-found', attemptKey: null }
    const acknowledge = vi.fn(() => outcome)
    registerWithLocalSale({ acknowledge })

    const handler = handlers.get(IPC_CHANNELS.checkoutAcknowledgeAttempt)
    const result = await handler?.(fakeEvent(), { attemptKey: ATTEMPT_KEY })

    expect(result).toEqual({ ok: true, data: outcome })
  })
})

describe('checkout:pending-attempts', () => {
  it('checks the sender before parsing the payload', async () => {
    assertTrustedSender.mockImplementation(() => {
      throw { category: 'authorization', message: 'untrusted', retryable: false }
    })
    const pendingAttempts = vi.fn()
    registerWithLocalSale({ pendingAttempts })

    const handler = handlers.get(IPC_CHANNELS.checkoutPendingAttempts)
    const result = await handler?.(fakeEvent(), {})

    expect(result).toMatchObject({ ok: false, error: { category: 'authorization' } })
    expect(pendingAttempts).not.toHaveBeenCalled()
  })

  it('never mutates: the read-only shape carries no attemptKey to act on, only a summary', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const pendingAttempts = vi.fn(() => ({
      blockingAttempt: {
        attemptKey: ATTEMPT_KEY,
        companyUuid: 'c',
        deviceUuid: 'd',
        userUuid: 'u',
        claimSessionEpoch: 1,
        originShiftUuid: 's',
        originShiftObservedAt: '2026-01-01T00:00:00.000Z',
        originBranchUuid: 'b',
        originWarehouseUuid: 'w',
        originContextFingerprint: 'f'.repeat(64),
        intentFingerprint: 'g'.repeat(64),
        intentVersion: 1,
        intentJson: '{"secret":"never-leaked"}',
        state: 'claimed' as const,
        invoiceLocalUuid: null,
        failureCode: null,
        claimedAt: '2026-01-01T00:00:00.000Z',
        lastAttemptedAt: null,
        committedAt: null,
        rejectedAt: null,
        acknowledgedAt: null,
        abandonedAt: null,
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      unacknowledgedResults: [],
      nextCursor: null
    }))
    registerWithLocalSale({ pendingAttempts })

    const handler = handlers.get(IPC_CHANNELS.checkoutPendingAttempts)
    const result = await handler?.(fakeEvent(), {})

    expect(pendingAttempts).toHaveBeenCalledWith(undefined, null)
    expect(result).toEqual({
      ok: true,
      data: {
        blockingAttempt: {
          attemptKey: ATTEMPT_KEY,
          state: 'claimed',
          claimedAt: '2026-01-01T00:00:00.000Z'
        },
        unacknowledgedResults: [],
        nextCursor: null
      }
    })
    expect(JSON.stringify(result)).not.toContain('never-leaked')
    expect(JSON.stringify(result)).not.toContain('intentFingerprint')
  })

  it('rejects a page size above the bounded maximum', async () => {
    assertTrustedSender.mockImplementation(() => undefined)
    const pendingAttempts = vi.fn()
    registerWithLocalSale({ pendingAttempts })

    const handler = handlers.get(IPC_CHANNELS.checkoutPendingAttempts)
    const result = await handler?.(fakeEvent(), { limit: 500 })

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } })
    expect(pendingAttempts).not.toHaveBeenCalled()
  })
})
