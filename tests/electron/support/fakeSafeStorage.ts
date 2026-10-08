import type { SafeStorageAdapter } from '../../../src/main/services/secureStorage.service'

/**
 * Electron's safeStorage API is unavailable under ELECTRON_RUN_AS_NODE. This is the sole
 * documented OS-API fake in the Electron SQLite harness; its non-identity transform still
 * proves BLOB persistence through secure_secrets.
 */
export function fakeSafeStorage(): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    // Stands in for a PROTECTED Linux key store, the precondition production enforces before any
    // credential is persisted (SecureStorageService.assertCanPersistSecrets). The fail-closed paths
    // (basic_text, unknown, unavailable) are covered by secureStorage/auth/license unit tests and the
    // `keystore` journey.
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value) => Buffer.from(`electron-test:${value}`, 'utf8'),
    decryptString: (value) => {
      const prefix = 'electron-test:'
      const decoded = value.toString('utf8')

      if (!decoded.startsWith(prefix)) {
        throw new Error('Invalid encrypted test secret')
      }

      return decoded.slice(prefix.length)
    }
  }
}
