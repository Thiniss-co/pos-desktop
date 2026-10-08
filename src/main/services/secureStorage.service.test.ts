import { describe, expect, it, vi } from 'vitest'
import {
  SECURE_STORAGE_INSECURE_BACKEND,
  SECURE_STORAGE_UNAVAILABLE,
  SecureStorageService
} from './secureStorage.service'

describe('SecureStorageService', () => {
  it('treats an undecryptable stored secret as no usable secret', () => {
    const repository = {
      get: () => Buffer.from('corrupt-ciphertext'),
      set: () => undefined,
      delete: () => undefined
    }
    const safeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (value: string) => Buffer.from(value),
      decryptString: () => {
        throw new Error('DPAPI decryption failed')
      }
    }

    const service = new SecureStorageService(repository, safeStorage)

    expect(service.getSecret('desktop_access_token')).toBeNull()
  })

  it('throws when encryption is unavailable rather than silently returning a secret', () => {
    const repository = { get: () => null, set: () => undefined, delete: () => undefined }
    const safeStorage = {
      isEncryptionAvailable: () => false,
      getSelectedStorageBackend: () => 'basic_text',
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString()
    }

    const service = new SecureStorageService(repository, safeStorage)

    expect(() => service.getSecret('desktop_access_token')).toThrow(
      'Encrypted secret storage is unavailable on this device'
    )
  })

  it('refuses to persist a secret on the basic_text backend, keeps what is stored, and says how to fix it', () => {
    const stored = new Map<string, Buffer>([['desktop_access_token', Buffer.from('existing')]])
    const repository = {
      get: (key: string) => stored.get(key) ?? null,
      set: vi.fn((key: string, value: Buffer) => void stored.set(key, value)),
      delete: vi.fn()
    }
    const encryptString = vi.fn((value: string) => Buffer.from(value))
    const safeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'basic_text',
      encryptString,
      decryptString: (value: Buffer) => value.toString()
    }

    const service = new SecureStorageService(repository, safeStorage, 'linux')

    expect(service.getStatus()).toEqual({
      encryptionAvailable: true,
      backend: 'basic_text',
      usesBasicTextBackend: true,
      canPersistSecrets: false
    })
    expect(() => service.setSecret('desktop_access_token', 'new-token')).toThrow(
      expect.objectContaining({
        category: 'configuration',
        backendCode: SECURE_STORAGE_INSECURE_BACKEND,
        message: expect.stringMatching(/keyring.*sign in again/i)
      })
    )
    expect(encryptString).not.toHaveBeenCalled()
    expect(repository.set).not.toHaveBeenCalled()
    // Nothing already stored is erased.
    expect(repository.delete).not.toHaveBeenCalled()
    expect(service.getSecret('desktop_access_token')).toBe('existing')
  })

  it('treats an unknown Linux backend as unprotected (fail closed)', () => {
    const repository = { get: () => null, set: vi.fn(), delete: () => undefined }
    const safeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'unknown',
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString()
    }

    const service = new SecureStorageService(repository, safeStorage, 'linux')

    expect(() => service.assertCanPersistSecrets()).toThrow(
      expect.objectContaining({ backendCode: SECURE_STORAGE_INSECURE_BACKEND })
    )
    expect(repository.set).not.toHaveBeenCalled()
  })

  it('refuses to persist when encryption is unavailable, with its own code', () => {
    const repository = { get: () => null, set: vi.fn(), delete: () => undefined }
    const safeStorage = {
      isEncryptionAvailable: () => false,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString()
    }

    const service = new SecureStorageService(repository, safeStorage, 'linux')

    expect(service.getStatus().canPersistSecrets).toBe(false)
    expect(() => service.setSecret('desktop_license_jwt', 'jwt')).toThrow(
      expect.objectContaining({
        category: 'configuration',
        backendCode: SECURE_STORAGE_UNAVAILABLE
      })
    )
    expect(repository.set).not.toHaveBeenCalled()
  })

  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])(
    'persists secrets on the protected Linux backend %s',
    (backend) => {
      const repository = { get: () => null, set: vi.fn(), delete: () => undefined }
      const safeStorage = {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => backend,
        encryptString: (value: string) => Buffer.from(`enc:${value}`),
        decryptString: (value: Buffer) => value.toString()
      }

      const service = new SecureStorageService(repository, safeStorage, 'linux')

      expect(service.getStatus().canPersistSecrets).toBe(true)
      service.setSecret('desktop_access_token', 'token')
      expect(repository.set).toHaveBeenCalledWith('desktop_access_token', Buffer.from('enc:token'))
    }
  )

  it.each(['win32', 'darwin'] as const)(
    'relies on the OS key store on %s (no Linux backend query)',
    (platform) => {
      const repository = { get: () => null, set: vi.fn(), delete: () => undefined }
      const safeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString()
      }

      const service = new SecureStorageService(repository, safeStorage, platform)

      expect(service.getStatus()).toMatchObject({ backend: 'os', canPersistSecrets: true })
      service.setSecret('desktop_access_token', 'token')
      expect(repository.set).toHaveBeenCalledTimes(1)
    }
  )

  it('round-trips a secret through encrypt and decrypt', () => {
    let stored: Buffer | null = null
    const repository = {
      get: () => stored,
      set: (_key: string, value: Buffer) => {
        stored = value
      },
      delete: () => {
        stored = null
      }
    }
    const safeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (value: string) => Buffer.from(`enc:${value}`),
      decryptString: (value: Buffer) => value.toString().replace(/^enc:/, '')
    }

    const service = new SecureStorageService(repository, safeStorage, 'linux')

    service.setSecret('desktop_access_token', 'plaintext-token')
    expect(service.getSecret('desktop_access_token')).toBe('plaintext-token')

    service.deleteSecret('desktop_access_token')
    expect(service.getSecret('desktop_access_token')).toBeNull()
  })
})
