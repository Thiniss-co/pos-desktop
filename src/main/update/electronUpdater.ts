import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import { createWindowsSignatureVerifier, type PowerShellRunner } from './authenticode'
import type { UpdaterLike } from './updateService'

/**
 * electron-updater for this platform (NSIS on Windows, AppImage on Linux), pointed at the feed baked
 * into this build. electron-updater checks every download against the SHA-512 in the feed's
 * metadata; on Windows it also compares the installer's Authenticode publisher with the running
 * app's (see docs/release/updates.md), through the fail-closed verifier in authenticode.ts. TLS
 * verification is never disabled.
 */
export function createElectronUpdater(
  feed: URL,
  log: (line: string) => void = () => undefined
): UpdaterLike {
  autoUpdater.logger = null
  autoUpdater.setFeedURL({ provider: 'generic', url: feed.href })
  if (process.platform === 'win32') {
    // electron-updater's own check accepts an update when PowerShell cannot run; this one refuses.
    ;(
      autoUpdater as unknown as {
        verifyUpdateCodeSignature: (names: string[], file: string) => Promise<string | null>
      }
    ).verifyUpdateCodeSignature = createWindowsSignatureVerifier(runWindowsPowerShell, log)
  }
  return autoUpdater as unknown as UpdaterLike
}

/** Windows PowerShell, without a shell and with UTF-8 output; PowerShell 7's module path is not inherited. */
const runWindowsPowerShell: PowerShellRunner = (command, timeoutMs) =>
  new Promise((resolve, reject) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH')
    )
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-InputFormat',
        'None',
        '-Command',
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`
      ],
      { timeout: timeoutMs, windowsHide: true, env, encoding: 'utf8' },
      (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr }))
    )
  })

/**
 * The updater configuration electron-builder writes into a packaged app (resources/app-update.yml).
 * A signed Windows build records its publisher there; null when the file is absent.
 */
export function readPackagedUpdaterConfig(): string | null {
  try {
    return readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8')
  } catch {
    return null
  }
}
