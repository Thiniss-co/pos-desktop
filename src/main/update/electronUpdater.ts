import { autoUpdater } from 'electron-updater'
import type { UpdaterLike } from './updateService'

/**
 * electron-updater for this platform (NSIS on Windows, AppImage on Linux), pointed at the feed baked
 * into this build. electron-updater checks every download against the SHA-512 in the feed's
 * metadata; on Windows it also compares the installer's Authenticode publisher with the running
 * app's when the build is signed (see docs/release/updates.md). TLS verification is never disabled.
 */
export function createElectronUpdater(feed: URL): UpdaterLike {
  autoUpdater.logger = null
  autoUpdater.setFeedURL({ provider: 'generic', url: feed.href })
  return autoUpdater as unknown as UpdaterLike
}
