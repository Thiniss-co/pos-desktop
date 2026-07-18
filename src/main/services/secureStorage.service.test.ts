import { describe, expect, it } from 'vitest'
import { SecureStorageService } from './secureStorage.service'

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

  it('surfaces the basic_text backend as a weak-backend flag without blocking usage', () => {
    const repository = { get: () => null, set: () => undefined, delete: () => undefined }
    const safeStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'basic_text',
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString()
    }

    const service = new SecureStorageService(repository, safeStorage)

    expect(service.getStatus()).toEqual({
      encryptionAvailable: true,
      backend: 'basic_text',
      usesBasicTextBackend: true
    })
  })

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

    const service = new SecureStorageService(repository, safeStorage)

    service.setSecret('desktop_access_token', 'plaintext-token')
    expect(service.getSecret('desktop_access_token')).toBe('plaintext-token')

    service.deleteSecret('desktop_access_token')
    expect(service.getSecret('desktop_access_token')).toBeNull()
  })
})
