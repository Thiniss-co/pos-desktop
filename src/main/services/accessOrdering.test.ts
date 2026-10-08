import { describe, expect, it } from 'vitest'
import {
  accessSequenceFromMeta,
  admitAccessAnswer,
  bootstrapRelaxes,
  StaleAccessResponseError,
  type AccessSequenceStore,
  type StoredAccessSequence
} from './accessOrdering'
import { OwnerChangedError, type RenewalOwner } from './renewalOwner'

function memoryStore(
  initial: StoredAccessSequence | null = null
): AccessSequenceStore & { value: StoredAccessSequence | null } {
  return {
    value: initial,
    get() {
      return this.value
    },
    set(value) {
      this.value = value
    }
  }
}

const owner = (overrides: Partial<RenewalOwner> = {}): RenewalOwner => ({
  sessionEpoch: 4,
  userUuid: 'u',
  userIsActive: true,
  companyUuid: 'c',
  deviceUuid: 'd-1',
  serverDeviceId: 's',
  branchUuid: null,
  warehouseUuid: null,
  ...overrides
})

describe('access answer ordering (Phase 6, C3)', () => {
  it('admits a newer sequence and stores it with the device and session epoch', () => {
    const store = memoryStore()
    admitAccessAnswer(store, owner(), 5, true)
    admitAccessAnswer(store, owner(), 7, false)
    expect(store.value).toEqual({ deviceUuid: 'd-1', sessionEpoch: 4, sequence: 7 })
  })

  it('discards an older allow that arrives after a newer deny, and an equal sequence', () => {
    const store = memoryStore({ deviceUuid: 'd-1', sessionEpoch: 4, sequence: 9 })
    expect(() => admitAccessAnswer(store, owner(), 8, true)).toThrow(StaleAccessResponseError)
    expect(() => admitAccessAnswer(store, owner(), 9, true)).toThrow(StaleAccessResponseError)
    expect(store.value?.sequence).toBe(9)
  })

  it('a stale answer is a discarded owner result (callers already treat it as "nothing written")', () => {
    const store = memoryStore({ deviceUuid: 'd-1', sessionEpoch: 4, sequence: 9 })
    expect(() => admitAccessAnswer(store, owner(), 1, false)).toThrow(OwnerChangedError)
  })

  it('a newer resume after a denial is admitted (higher sequence)', () => {
    const store = memoryStore({ deviceUuid: 'd-1', sessionEpoch: 4, sequence: 9 })
    admitAccessAnswer(store, owner(), 10, true)
    expect(store.value?.sequence).toBe(10)
  })

  it('another device or a new session epoch starts a fresh order', () => {
    const store = memoryStore({ deviceUuid: 'd-1', sessionEpoch: 4, sequence: 50 })
    admitAccessAnswer(store, owner({ deviceUuid: 'd-2' }), 1, true)
    expect(store.value).toEqual({ deviceUuid: 'd-2', sessionEpoch: 4, sequence: 1 })
    admitAccessAnswer(store, owner({ deviceUuid: 'd-2', sessionEpoch: 5 }), 1, true)
    expect(store.value).toEqual({ deviceUuid: 'd-2', sessionEpoch: 5, sequence: 1 })
  })

  it('an unsequenced answer (older backend) may restrict but never relax once a sequence was accepted', () => {
    const store = memoryStore({ deviceUuid: 'd-1', sessionEpoch: 4, sequence: 3 })
    expect(() => admitAccessAnswer(store, owner(), null, false)).not.toThrow()
    expect(() => admitAccessAnswer(store, owner(), null, true)).toThrow(StaleAccessResponseError)
    expect(store.value?.sequence).toBe(3)
  })

  it('without any accepted sequence, behaviour is unchanged (legacy)', () => {
    const store = memoryStore()
    expect(() => admitAccessAnswer(store, owner(), null, true)).not.toThrow()
    expect(store.value).toBeNull()
  })

  it('reads only positive safe integers from the envelope meta', () => {
    expect(accessSequenceFromMeta({ access_sequence: 12 })).toBe(12)
    expect(accessSequenceFromMeta({ access_sequence: '12' })).toBeNull()
    expect(accessSequenceFromMeta({ access_sequence: 0 })).toBeNull()
    expect(accessSequenceFromMeta({})).toBeNull()
    expect(accessSequenceFromMeta(undefined)).toBeNull()
  })

  it('a bootstrap relaxes when it opens selling/syncing, a feature or a permission that the stored state does not have', () => {
    const stored = {
      canSell: true,
      canSync: true,
      enabledFeatures: new Set(['pos', 'inventory']),
      permissions: new Set(['sales.create', 'shifts.manage'])
    }
    const same = {
      license: { can_sell: true, can_sync: true },
      features: { pos: true, inventory: true },
      permissions: ['sales.create', 'shifts.manage']
    }

    expect(bootstrapRelaxes(same, stored)).toBe(false)
    // Restrictions only: selling off, a feature off, a permission removed.
    expect(
      bootstrapRelaxes(
        {
          license: { can_sell: false, can_sync: true },
          features: { pos: true, inventory: false },
          permissions: ['sales.create']
        },
        stored
      )
    ).toBe(false)
    // Relaxations, one at a time.
    expect(bootstrapRelaxes(same, { ...stored, canSell: false })).toBe(true)
    expect(bootstrapRelaxes(same, { ...stored, canSync: false })).toBe(true)
    expect(
      bootstrapRelaxes({ ...same, features: { ...same.features, loyalty_points: true } }, stored)
    ).toBe(true)
    expect(
      bootstrapRelaxes({ ...same, permissions: [...same.permissions, 'refunds.create'] }, stored)
    ).toBe(true)
    // Nothing stored: every answer counts as relaxing.
    expect(bootstrapRelaxes(same, null)).toBe(true)
  })
})
