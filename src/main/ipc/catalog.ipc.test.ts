import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/constants/ipcChannels'
import type { ApplicationServices } from '../app/applicationServices'
import type { CatalogRepository, CatalogSnapshot } from '../repositories/catalog.repository'
import type { DeviceRegistrationRecord } from '../repositories/deviceRegistration.repository'
import type { SessionContext } from '../repositories/sessionMetadata.repository'
import type { StoredDeviceIdentity } from '../services/deviceIdentity.service'
import { CatalogReadAccessService } from '../services/catalogReadAccess.service'
import { CatalogService } from '../services/catalog.service'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => {
        handlers.set(channel, handler)
      }
    )
  }
}))

const { assertTrustedSender } = vi.hoisted(() => ({ assertTrustedSender: vi.fn() }))
vi.mock('./assertTrustedSender', () => ({ assertTrustedSender }))

import { registerCatalogIpcHandlers } from './catalog.ipc'

const DEVICE_UUID = '33333333-3333-4333-8333-333333333333'
const SERVER_DEVICE_ID = '22222222-2222-4222-8222-222222222222'
const COMPANY_UUID = '11111111-1111-4111-8111-111111111111'
const REVISION = 'a'.repeat(64)

const identity: StoredDeviceIdentity = {
  deviceUuid: DEVICE_UUID,
  deviceName: 'Example Register',
  platform: 'linux',
  osVersion: '6.0',
  appVersion: '1.0.0',
  isRegistered: true
}

const registration: DeviceRegistrationRecord = {
  serverDeviceId: SERVER_DEVICE_ID,
  status: 'active',
  lastSeenAt: '2026-01-01T00:00:00+00:00',
  updatedAt: '2026-01-01T00:00:00+00:00'
}

const authorizedSession: SessionContext = {
  isAuthenticated: true,
  userUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userIsActive: true,
  companyUuid: COMPANY_UUID,
  deviceUuid: DEVICE_UUID,
  serverDeviceId: SERVER_DEVICE_ID
}

const snapshot: CatalogSnapshot = {
  contract: {
    revision: REVISION,
    generatedAt: '2026-01-01T00:00:00+00:00',
    validUntil: '2026-01-05T00:00:00+00:00',
    currency: 'SAR',
    currencyExponent: 2,
    quantityScale: 3,
    minimumQuantity: '0.001',
    maximumQuantity: '999999.999',
    maximumUnitPrice: 1_000_000_000,
    maximumLineTotal: 900_000_000_000_000,
    maximumInvoiceTotal: 900_000_000_000_000,
    mixedTaxModePolicy: 'single_invoice_mode'
  },
  fetchedAt: '2026-01-01T00:01:00+00:00',
  manifest: {
    categories: 1,
    products: 1,
    barcodes: 1,
    priceRevisions: 1,
    taxRevisions: 1,
    paymentMethods: 1,
    customers: 1
  }
}

const PRODUCT_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CUSTOMER_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const product = {
  uuid: PRODUCT_UUID,
  categoryUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  name: 'Bottled Water',
  sku: 'SKU-1',
  barcode: '4006381333931',
  description: null,
  unit: null,
  trackStock: true,
  availableQuantity: '10.000',
  price: {
    amount: 1500,
    currency: 'SAR',
    source: 'product_base',
    revision: REVISION,
    validFrom: '2026-01-01T00:00:00+00:00',
    validUntil: '2026-01-05T00:00:00+00:00'
  },
  tax: {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    mode: 'exclusive',
    rateBasisPoints: 1500,
    revision: REVISION
  }
} as const

const customer = { uuid: CUSTOMER_UUID, name: 'Walk-in', phone: null } as const

interface Harness {
  readonly repository: {
    readonly listCategories: ReturnType<typeof vi.fn>
    readonly searchProducts: ReturnType<typeof vi.fn>
    readonly searchCustomers: ReturnType<typeof vi.fn>
    readonly findProductsByBarcode: ReturnType<typeof vi.fn>
    readonly listPaymentMethods: ReturnType<typeof vi.fn>
    readonly getCustomer: ReturnType<typeof vi.fn>
    readonly getProduct: ReturnType<typeof vi.fn>
  }
  invoke(channel: string, input?: unknown): Promise<unknown>
}

function harness(options: {
  readonly permissions?: readonly string[]
  readonly session?: SessionContext
  readonly registration?: DeviceRegistrationRecord | null
  readonly token?: string | null
}): Harness {
  const repository = {
    getSnapshot: vi.fn(() => snapshot),
    isSnapshotIntact: vi.fn(() => true),
    listCategories: vi.fn(() => [{ uuid: product.categoryUuid, name: 'Drinks' }]),
    searchProducts: vi.fn(() => ({ items: [product], total: 1 })),
    getProduct: vi.fn(() => product),
    findProductsByBarcode: vi.fn(() => [product]),
    listPaymentMethods: vi.fn(() => [
      { uuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Cash', code: 'cash', type: 'cash' }
    ]),
    searchCustomers: vi.fn(() => ({ items: [customer], total: 1, limit: 24, offset: 0 })),
    getCustomer: vi.fn(() => customer)
  }

  const permissions = options.permissions ?? ['pos.view']
  const access = new CatalogReadAccessService({
    identity: { get: () => identity },
    // `in` rather than `??` so an explicit null (a cleared token, a removed registration) is
    // honoured instead of silently falling back to the authorized default.
    deviceRegistration: {
      get: () => ('registration' in options ? options.registration : registration) ?? null
    },
    session: { getContext: () => options.session ?? authorizedSession },
    secrets: { getSecret: () => ('token' in options ? options.token : 'desktop-token') ?? null },
    company: {
      getCompany: () => ({
        companyUuid: COMPANY_UUID,
        name: 'Example Co',
        isActive: true,
        updatedAt: '2026-01-01T00:00:00+00:00'
      })
    },
    permissions: { hasPermission: (permission) => permissions.includes(permission) }
  })

  const catalog = new CatalogService(
    repository as unknown as CatalogRepository,
    access,
    // Held inside the snapshot validity window so provenance never masks an authorization result.
    { now: () => ({ now: new Date('2026-01-02T00:00:00.000Z'), rollbackDetected: false }) }
  )

  handlers.clear()
  registerCatalogIpcHandlers({ catalog } as ApplicationServices)

  return {
    repository,
    invoke: async (channel, input) => {
      const handler = handlers.get(channel)
      expect(handler, `no handler registered for ${channel}`).toBeDefined()
      return handler?.({}, input)
    }
  }
}

const READ_CHANNELS: ReadonlyArray<readonly [string, unknown]> = [
  [IPC_CHANNELS.catalogListCategories, undefined],
  [IPC_CHANNELS.catalogSearchProducts, { query: '', categoryUuid: null, limit: 24, offset: 0 }],
  [IPC_CHANNELS.catalogGetProduct, { uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
  [IPC_CHANNELS.catalogListPaymentMethods, undefined],
  [IPC_CHANNELS.catalogSearchCustomers, { query: '', limit: 24, offset: 0 }],
  [IPC_CHANNELS.catalogGetCustomer, { uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]
]

const SANITIZED_UNAVAILABLE = {
  status: 'unavailable',
  isReadable: false,
  catalogValid: false,
  lastSyncedAt: null,
  contract: null
}

describe('catalog IPC authorization', () => {
  it('allows a pos.view session to read directly over IPC without pos.sell', async () => {
    const { invoke, repository } = harness({ permissions: ['pos.view'] })

    await expect(invoke(IPC_CHANNELS.catalogGetStatus)).resolves.toMatchObject({
      ok: true,
      data: { status: 'cached', isReadable: true, catalogValid: true }
    })

    for (const [channel, input] of READ_CHANNELS) {
      await expect(invoke(channel, input)).resolves.toMatchObject({ ok: true })
    }

    expect(repository.listCategories).toHaveBeenCalled()
    expect(repository.searchProducts).toHaveBeenCalled()
  })

  it.each([
    ['a session missing pos.view', { permissions: ['pos.sell', 'shifts.manage'] }],
    ['a lost session', { session: { ...authorizedSession, isAuthenticated: false } }],
    ['a deactivated user', { session: { ...authorizedSession, userIsActive: false } }],
    [
      'a device mismatch',
      { session: { ...authorizedSession, serverDeviceId: SERVER_DEVICE_ID.replace('2', '9') } }
    ],
    ['a company mismatch', { session: { ...authorizedSession, companyUuid: DEVICE_UUID } }],
    ['a terminated device', { registration: { ...registration, status: 'revoked' } }],
    ['a cleared access token', { token: null }]
  ])('denies every direct catalog IPC read for %s', async (_label, options) => {
    const { invoke, repository } = harness(options)

    for (const [channel, input] of READ_CHANNELS) {
      await expect(invoke(channel, input)).resolves.toMatchObject({
        ok: false,
        error: {
          category: 'authorization',
          backendCode: 'CATALOG_READ_ACCESS_DENIED',
          retryable: false
        }
      })
    }

    // Status and barcode lookup fail closed through sanitized projections rather than errors, so
    // an unauthorized renderer still learns nothing about the retained snapshot.
    await expect(invoke(IPC_CHANNELS.catalogGetStatus)).resolves.toEqual({
      ok: true,
      data: SANITIZED_UNAVAILABLE
    })
    await expect(
      invoke(IPC_CHANNELS.catalogFindByBarcode, { barcode: '4006381333931' })
    ).resolves.toEqual({ ok: true, data: { outcome: 'unavailable-catalog' } })

    for (const query of Object.values(repository)) {
      expect(query).not.toHaveBeenCalled()
    }
  })
})

describe('catalog IPC input contracts', () => {
  it.each([
    ['an unknown search key', IPC_CHANNELS.catalogSearchProducts, { query: '', extra: true }],
    ['an over-large page', IPC_CHANNELS.catalogSearchProducts, { limit: 51 }],
    ['a negative offset', IPC_CHANNELS.catalogSearchProducts, { offset: -1 }],
    ['an out-of-range offset', IPC_CHANNELS.catalogSearchProducts, { offset: 10_001 }],
    ['an over-long query', IPC_CHANNELS.catalogSearchProducts, { query: 'x'.repeat(101) }],
    ['a non-uuid category', IPC_CHANNELS.catalogSearchProducts, { categoryUuid: 'not-a-uuid' }],
    ['an over-large customer page', IPC_CHANNELS.catalogSearchCustomers, { limit: 51 }],
    ['a malformed product uuid', IPC_CHANNELS.catalogGetProduct, { uuid: 'not-a-uuid' }],
    ['a missing product uuid', IPC_CHANNELS.catalogGetProduct, {}],
    ['a malformed customer uuid', IPC_CHANNELS.catalogGetCustomer, { uuid: '1' }],
    ['an empty barcode', IPC_CHANNELS.catalogFindByBarcode, { barcode: '' }],
    ['an over-long barcode', IPC_CHANNELS.catalogFindByBarcode, { barcode: '9'.repeat(256) }],
    ['a non-object payload', IPC_CHANNELS.catalogFindByBarcode, 'ignored'],
    ['an argument to a no-input read', IPC_CHANNELS.catalogListCategories, { limit: 1000 }]
  ])('rejects %s before reaching the repository', async (_label, channel, input) => {
    const { invoke, repository } = harness({})

    await expect(invoke(channel, input)).resolves.toMatchObject({
      ok: false,
      error: { category: 'validation', retryable: false }
    })

    for (const query of Object.values(repository)) {
      expect(query).not.toHaveBeenCalled()
    }
  })
})

/**
 * `catalog:refresh` is the only catalog channel that mutates durable state and reaches the
 * network, so it carries the same security shape as the checkout write channels: trusted sender
 * asserted *before* the payload is parsed, a `.strict()` empty input, and no caller-supplied
 * identity of any kind.
 */
describe('catalog:refresh IPC security', () => {
  interface RefreshHarness {
    readonly refresh: ReturnType<typeof vi.fn>
    invoke(input?: unknown): Promise<unknown>
  }

  function refreshHarness(result: unknown = { ok: true }): RefreshHarness {
    const refresh = vi.fn(async () => result)
    handlers.clear()
    assertTrustedSender.mockReset()
    registerCatalogIpcHandlers({
      catalogRefresh: { refresh }
    } as unknown as ApplicationServices)

    return {
      refresh,
      invoke: async (input) => {
        const handler = handlers.get(IPC_CHANNELS.catalogRefresh)
        expect(handler, 'no handler registered for catalog:refresh').toBeDefined()
        return handler?.({}, input)
      }
    }
  }

  it('registers the refresh channel', () => {
    refreshHarness()
    expect(handlers.has(IPC_CHANNELS.catalogRefresh)).toBe(true)
  })

  it('asserts the trusted sender before the service is reached', async () => {
    const { invoke, refresh } = refreshHarness()
    assertTrustedSender.mockImplementation(() => {
      throw {
        category: 'authorization',
        message: 'This request could not be verified.',
        retryable: false
      }
    })

    await expect(invoke()).resolves.toMatchObject({
      ok: false,
      error: { category: 'authorization', retryable: false }
    })
    // The only thing on the mock is the throw, so "never called" is a genuine ordering proof.
    expect(refresh).not.toHaveBeenCalled()
  })

  it('asserts the trusted sender before the payload is parsed', async () => {
    const { invoke, refresh } = refreshHarness()
    assertTrustedSender.mockImplementation(() => {
      throw {
        category: 'authorization',
        message: 'This request could not be verified.',
        retryable: false
      }
    })

    // A payload that would also fail validation must still surface the authorization refusal,
    // proving the sender check ran first rather than the schema.
    await expect(invoke({ companyUuid: 'anything' })).resolves.toMatchObject({
      ok: false,
      error: { category: 'authorization' }
    })
    expect(refresh).not.toHaveBeenCalled()
  })

  it.each([
    ['a fabricated company', { companyUuid: '11111111-1111-4111-8111-111111111111' }],
    ['a fabricated device', { deviceUuid: '33333333-3333-4333-8333-333333333333' }],
    ['a fabricated warehouse', { warehouseUuid: '88888888-8888-4888-8888-888888888888' }],
    ['a caller-chosen catalog revision', { revision: 'b'.repeat(64) }],
    ['a force flag', { force: true }],
    ['a non-object payload', 'ignored'],
    // Not even an empty object: the channel takes no argument whatsoever.
    ['an empty object', {}]
  ])('rejects %s before the service is reached', async (_label, input) => {
    const { invoke, refresh } = refreshHarness()

    await expect(invoke(input)).resolves.toMatchObject({
      ok: false,
      error: { category: 'validation', retryable: false }
    })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('delegates an authorized empty request to the refresh service unmodified', async () => {
    const outcome = {
      status: {
        status: 'fresh',
        isReadable: true,
        catalogValid: true,
        lastSyncedAt: '2026-01-01T00:00:00+00:00',
        contract: null
      },
      refreshedAt: '2026-01-01T00:00:00+00:00',
      previousRevision: null,
      revisionChanged: false,
      counts: {},
      access: {
        sell: { allowed: true, reason: null, warning: null, action: 'sell' },
        sync: { allowed: true, reason: null, warning: null, action: 'sync' }
      },
      licenseValidatedAt: '2026-01-01T00:00:00+00:00'
    }
    const { invoke, refresh } = refreshHarness(outcome)

    // Exactly how `posApi.catalog.refresh()` invokes it: no argument at all.
    await expect(invoke()).resolves.toEqual({ ok: true, data: outcome })
    expect(refresh).toHaveBeenCalledTimes(1)
    // Argument-free by contract: main derives every identity itself.
    expect(refresh).toHaveBeenCalledWith()
  })
})
