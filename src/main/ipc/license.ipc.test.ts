import { describe, expect, it } from 'vitest'
import {
  commercialAccessReasonSchema,
  commercialAccessSnapshotSchema
} from '@shared/contracts/license.contract'
import {
  licenseGetAccessInputSchema,
  licenseValidateInputSchema
} from '@shared/validators/ipc.validators'
import { handleIpcRequest } from './handleIpcRequest'

describe('license access IPC validation', () => {
  it('rejects renderer payloads for the read-only access routes', async () => {
    const validate = await handleIpcRequest(
      { canSell: true },
      licenseValidateInputSchema,
      () => 'not called'
    )
    const getAccess = await handleIpcRequest(
      { reason: null },
      licenseGetAccessInputSchema,
      () => 'not called'
    )

    expect(validate).toMatchObject({ ok: false, error: { category: 'validation' } })
    expect(getAccess).toMatchObject({ ok: false, error: { category: 'validation' } })
  })

  it('serializes every local denial as the strict, renderer-safe projection', () => {
    for (const reason of commercialAccessReasonSchema.options) {
      const snapshot = commercialAccessSnapshotSchema.parse({
        sell: {
          allowed: false,
          reason,
          warning: null,
          action: 'sell',
          retryable: reason === 'connectivity-unavailable',
          evaluatedAt: '2026-01-01T00:00:00Z',
          nextValidationDueAt: '2026-01-04T00:00:00Z',
          restrictionLevel: 'none',
          warningMessage: null
        },
        sync: {
          allowed: true,
          reason: null,
          warning: null,
          action: 'sync',
          retryable: false,
          evaluatedAt: '2026-01-01T00:00:00Z',
          nextValidationDueAt: '2026-01-04T00:00:00Z',
          restrictionLevel: 'none',
          warningMessage: null
        }
      })

      expect(commercialAccessSnapshotSchema.safeParse(snapshot).success).toBe(true)
      expect(Object.keys(snapshot.sell).sort()).toEqual([
        'action',
        'allowed',
        'evaluatedAt',
        'nextValidationDueAt',
        'reason',
        'restrictionLevel',
        'retryable',
        'warning',
        'warningMessage'
      ])
    }
  })
})
