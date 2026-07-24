import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { publicAppErrorSchema, type PublicAppError } from '@shared/contracts/api.contract'
import { LicenseService } from '@renderer/modules/license/service'
import { BootstrapService } from './service'
import { useBootstrapStore } from './store'

function successfulLicenseService(): LicenseService {
  return new LicenseService({
    validate: async () => ({
      ok: true,
      data: {
        restrictionLevel: 'none',
        canSell: true,
        canSync: true,
        isActive: true,
        isInGrace: false,
        isExpired: false,
        expiresAt: null,
        warningMessage: null,
        validatedAt: '2026-01-01T00:00:00Z'
      }
    })
  })
}

function failingBootstrapService(error: PublicAppError): BootstrapService {
  return new BootstrapService({
    getStatus: async () => ({ ok: true, data: { isComplete: false, updatedAt: null } }),
    refresh: async () => ({ ok: false, error })
  })
}

describe('useBootstrapStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shows a contract-invalid bootstrap failure without allowing retry', async () => {
    const store = useBootstrapStore()
    const contractError = publicAppErrorSchema.parse({
      category: 'unexpected',
      message:
        'The service returned unsupported bootstrap data. Please update the desktop application or contact support.',
      backendCode: 'bootstrap_payload_contract_invalid',
      retryable: false
    })

    const succeeded = await store.runBootstrap(
      successfulLicenseService(),
      failingBootstrapService(contractError)
    )

    expect(succeeded).toBe(false)
    expect(store.error).toBe(contractError.message)
    expect(store.isRetryable).toBe(false)
  })

  it('keeps transport bootstrap failures retryable', async () => {
    const store = useBootstrapStore()
    const transportError = publicAppErrorSchema.parse({
      category: 'transport',
      message: 'The desktop service is unreachable',
      retryable: true
    })

    const succeeded = await store.runBootstrap(
      successfulLicenseService(),
      failingBootstrapService(transportError)
    )

    expect(succeeded).toBe(false)
    expect(store.error).toBe(transportError.message)
    expect(store.isRetryable).toBe(true)
  })
})
