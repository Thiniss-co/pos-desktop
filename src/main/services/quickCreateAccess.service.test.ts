import { describe, expect, it } from 'vitest'
import { QuickCreateAccessService } from './quickCreateAccess.service'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

function service(options: {
  permissions?: string[]
  features?: string[]
  capability?: number | null
  owner?: string | null
  session?: string | null
}): QuickCreateAccessService {
  const permissions = new Set(options.permissions ?? [])
  const features = new Set(options.features ?? ['pos', 'inventory'])
  return new QuickCreateAccessService({
    snapshot: {
      hasPermission: (p) => permissions.has(p),
      isFeatureEnabled: (f) => features.has(f),
      getCapabilityVersion: () => (options.capability === undefined ? 1 : options.capability),
      getPermissionsOwnerUserUuid: () => (options.owner === undefined ? USER : options.owner)
    },
    session: {
      getContext: () => ({ userUuid: options.session === undefined ? USER : options.session })
    }
  })
}

describe('QuickCreateAccessService', () => {
  it('grants only what the narrow create or the broader manage permission covers', () => {
    expect(service({ permissions: ['customers.create'] }).access()).toEqual({
      available: true,
      customer: true,
      supplier: false,
      product: false
    })
    expect(service({ permissions: ['catalog.manage', 'suppliers.manage'] }).access()).toEqual({
      available: true,
      customer: false,
      supplier: true,
      product: true
    })
  })

  it('denies everything for a plain cashier and throws PERMISSION_DENIED on a direct create', () => {
    const cashier = service({ permissions: ['pos.sell', 'pos.view'] })
    expect(cashier.access()).toEqual({
      available: true,
      customer: false,
      supplier: false,
      product: false
    })
    expect(() => cashier.assertCanCreate('customer')).toThrowError(
      expect.objectContaining({ backendCode: 'PERMISSION_DENIED', category: 'authorization' })
    )
  })

  it('requires the plan feature of the entity', () => {
    const noInventory = service({ permissions: ['suppliers.create'], features: ['pos'] })
    expect(noInventory.access().supplier).toBe(false)
    expect(() => noInventory.assertCanCreate('supplier')).toThrow()
  })

  it('treats a server without the negotiated capability as unavailable (older backend)', () => {
    const old = service({ permissions: ['customers.create'], capability: null })
    expect(old.access()).toEqual({
      available: false,
      customer: false,
      supplier: false,
      product: false
    })
    expect(() => old.assertCanCreate('customer')).toThrowError(
      expect.objectContaining({ backendCode: 'FEATURE_NOT_ENABLED' })
    )
  })

  it('never trusts a permission cache filled for another user, or an unknown owner', () => {
    expect(service({ permissions: ['customers.create'], owner: OTHER }).access().customer).toBe(
      false
    )
    expect(service({ permissions: ['customers.create'], owner: null }).access().customer).toBe(
      false
    )
    expect(service({ permissions: ['customers.create'], session: null }).access().customer).toBe(
      false
    )
    expect(() =>
      service({ permissions: ['customers.manage'], owner: OTHER }).assertCanCreate('customer')
    ).toThrowError(expect.objectContaining({ backendCode: 'PERMISSION_DENIED' }))
  })
})
