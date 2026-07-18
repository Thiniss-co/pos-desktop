export interface SecureSecretRepository {
  get(key: string): Buffer | null
  set(key: string, encryptedValue: Buffer): void
  delete(key: string): void
}

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface SecureStorageStatus {
  readonly encryptionAvailable: boolean
  readonly backend: string
  readonly usesBasicTextBackend: boolean
}

export class SecureStorageService {
  constructor(
    private readonly repository: SecureSecretRepository,
    private readonly safeStorage: SafeStorageAdapter
  ) {}

  getStatus(): SecureStorageStatus {
    const encryptionAvailable = this.safeStorage.isEncryptionAvailable()
    const backend = this.safeStorage.getSelectedStorageBackend()

    return {
      encryptionAvailable,
      backend,
      usesBasicTextBackend: backend === 'basic_text'
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
    this.assertEncryptionAvailable()
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
