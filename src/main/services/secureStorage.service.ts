import type { PublicAppError } from '@shared/contracts/api.contract'
import { createPublicError } from '../http/apiError'

export interface SecureSecretRepository {
  get(key: string): Buffer | null
  set(key: string, encryptedValue: Buffer): void
  delete(key: string): void
}

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean
  /** Linux only (Electron): which key store protects the encryption key. */
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface SecureStorageStatus {
  readonly encryptionAvailable: boolean
  readonly backend: string
  readonly usesBasicTextBackend: boolean
  /** True only when a new secret may be persisted (see `assertCanPersistSecrets`). */
  readonly canPersistSecrets: boolean
}

/**
 * Linux key stores that actually protect the encryption key. `basic_text` is Chromium's fallback when
 * no keyring is reachable: it encrypts with a fixed, publicly known key, which is plaintext-equivalent.
 * `unknown` (no backend selected) is treated the same way: fail closed.
 */
const LINUX_PROTECTED_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])

export const SECURE_STORAGE_UNAVAILABLE = 'SECURE_STORAGE_UNAVAILABLE'
export const SECURE_STORAGE_INSECURE_BACKEND = 'SECURE_STORAGE_INSECURE_BACKEND'

export class SecureStorageService {
  constructor(
    private readonly repository: SecureSecretRepository,
    private readonly safeStorage: SafeStorageAdapter,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  getStatus(): SecureStorageStatus {
    const encryptionAvailable = this.safeStorage.isEncryptionAvailable()
    // On Windows and macOS the OS key store (DPAPI, Keychain) always backs safeStorage.
    const backend =
      this.platform === 'linux' && this.safeStorage.getSelectedStorageBackend
        ? this.safeStorage.getSelectedStorageBackend()
        : 'os'

    return {
      encryptionAvailable,
      backend,
      usesBasicTextBackend: backend === 'basic_text',
      canPersistSecrets:
        encryptionAvailable && (this.platform !== 'linux' || LINUX_PROTECTED_BACKENDS.has(backend))
    }
  }

  /**
   * Fails closed before any credential is written (or requested from the server): a desktop token
   * or licence is never stored where it would be readable as plaintext. The error carries a stable
   * code and an actionable message; nothing already stored is erased.
   */
  assertCanPersistSecrets(): void {
    const status = this.getStatus()

    if (!status.canPersistSecrets) {
      throw secureStorageError(status)
    }
  }

  getSecret(key: string): string | null {
    this.assertEncryptionAvailable()
    const encryptedValue = this.repository.get(key)

    if (!encryptedValue) {
      return null
    }

    try {
      return this.safeStorage.decryptString(encryptedValue)
    } catch {
      return null
    }
  }

  setSecret(key: string, value: string): void {
    this.assertCanPersistSecrets()
    this.repository.set(key, this.safeStorage.encryptString(value))
  }

  deleteSecret(key: string): void {
    this.repository.delete(key)
  }

  private assertEncryptionAvailable(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Encrypted secret storage is unavailable on this device')
    }
  }
}

function secureStorageError(status: SecureStorageStatus): PublicAppError {
  if (!status.encryptionAvailable) {
    return createPublicError(
      'configuration',
      'This workstation cannot encrypt sign-in credentials. Start and unlock a system keyring (GNOME Keyring or KWallet), restart the app, then sign in again.',
      false,
      { backendCode: SECURE_STORAGE_UNAVAILABLE }
    )
  }

  return createPublicError(
    'configuration',
    `This workstation has no protected keyring (${status.backend}), so sign-in credentials would be stored unprotected. Install and unlock GNOME Keyring or KWallet, restart the app, then sign in again.`,
    false,
    { backendCode: SECURE_STORAGE_INSECURE_BACKEND }
  )
}
