import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { RestartBlocker, UpdateStatus } from '@shared/contracts/update.contract'
import { UPDATE_RETRY_DELAYS_MS, UpdateService, type UpdaterLike } from './updateService'

class FakeUpdater extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = true
  allowDowngrade = true
  checkForUpdates = vi.fn(async () => undefined)
  quitAndInstall = vi.fn()
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- local test fixture
function harness(
  options: {
    updater?: FakeUpdater | null
    online?: boolean
    verification?: 'publisher_signature' | 'checksum_only_test_build' | 'checksum_only' | null
    refusal?: string | null
  } = {}
) {
  const updater = options.updater === undefined ? new FakeUpdater() : options.updater
  const timers: { callback: () => void; delayMs: number }[] = []
  const statuses: UpdateStatus[] = []
  let blockers: RestartBlocker[] = []
  let online = options.online ?? true
  const service = new UpdateService({
    updater: updater as unknown as UpdaterLike | null,
    verification: options.verification ?? null,
    refusal: options.refusal ?? null,
    currentVersion: '1.0.0',
    isOnline: () => online,
    restartBlockers: () => blockers,
    onStatus: (status) => statuses.push(status),
    now: () => new Date('2026-10-09T10:00:00.000Z'),
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs }
      timers.push(timer)
      return () => timers.splice(timers.indexOf(timer), 1)
    },
    startupDelayMs: 30_000,
    intervalMs: 14_400_000
  })
  return {
    service,
    updater,
    timers,
    statuses,
    setBlockers: (next: RestartBlocker[]) => (blockers = next),
    setOnline: (next: boolean) => (online = next),
    async fire(): Promise<void> {
      const timer = timers.shift()
      timer?.callback()
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

describe('UpdateService', () => {
  it('reports not_configured without a feed and never installs', () => {
    const h = harness({ updater: null })
    h.service.start()

    expect(h.service.status().phase).toBe('not_configured')
    expect(h.service.restartToInstall()).toEqual({ restarting: false, blockers: [] })
    expect(h.timers).toHaveLength(0)
  })

  it('reports an unsigned Windows build that refuses updates, and never checks', () => {
    const h = harness({ updater: null, refusal: 'UNSIGNED_BUILD' })
    h.service.start()

    expect(h.service.status()).toMatchObject({
      phase: 'not_configured',
      errorCode: 'UNSIGNED_BUILD',
      verification: null
    })
    expect(h.service.restartToInstall()).toEqual({ restarting: false, blockers: [] })
    expect(h.timers).toHaveLength(0)
  })

  it('reports how downloads are verified', () => {
    expect(harness({ verification: 'publisher_signature' }).service.status().verification).toBe(
      'publisher_signature'
    )
    expect(
      harness({ verification: 'checksum_only_test_build' }).service.status().verification
    ).toBe('checksum_only_test_build')
  })

  it('downloads in the background but never installs on quit or downgrades', () => {
    const h = harness()
    h.service.start()

    expect(h.updater?.autoDownload).toBe(true)
    expect(h.updater?.autoInstallOnAppQuit).toBe(false)
    expect(h.updater?.allowDowngrade).toBe(false)
    expect(h.timers[0].delayMs).toBe(30_000)
  })

  it('goes checking → downloading → ready with progress, then waits for the cashier', async () => {
    const h = harness()
    const updater = h.updater as FakeUpdater
    h.service.start()
    await h.fire()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)

    updater.emit('checking-for-update')
    expect(h.service.status().phase).toBe('checking')
    updater.emit('update-available', { version: '1.1.0' })
    updater.emit('download-progress', { percent: 42.4 })
    expect(h.service.status()).toMatchObject({
      phase: 'downloading',
      availableVersion: '1.1.0',
      percent: 42
    })
    updater.emit('update-downloaded', { version: '1.1.0' })
    expect(h.service.status()).toMatchObject({ phase: 'ready', percent: 100 })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('refuses the restart while work would be interrupted, and restarts once it is clear', async () => {
    const h = harness()
    const updater = h.updater as FakeUpdater
    h.service.start()
    updater.emit('update-downloaded', { version: '1.1.0' })

    h.setBlockers(['sale_in_progress', 'print_in_progress'])
    expect(h.service.status().blockers).toEqual(['sale_in_progress', 'print_in_progress'])
    expect(h.service.restartToInstall()).toEqual({
      restarting: false,
      blockers: ['sale_in_progress', 'print_in_progress']
    })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    h.setBlockers([])
    expect(h.service.restartToInstall()).toEqual({ restarting: true, blockers: [] })
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(h.timers).toHaveLength(0)
  })

  it('backs off 1, 5, 15, 60, 60 minutes after failures and resets after a success', async () => {
    const h = harness()
    const updater = h.updater as FakeUpdater
    updater.checkForUpdates.mockRejectedValue(Object.assign(new Error('boom'), { code: 'ERR_X' }))
    h.service.start()

    const delays: number[] = []
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await h.fire()
      delays.push(h.timers[0].delayMs)
    }
    expect(delays).toEqual([...UPDATE_RETRY_DELAYS_MS, 3_600_000])
    expect(h.service.status()).toMatchObject({ phase: 'error', errorCode: 'ERR_X' })

    updater.checkForUpdates.mockResolvedValue(undefined)
    await h.fire()
    updater.emit('update-not-available')
    expect(h.service.status()).toMatchObject({ phase: 'idle', errorCode: null })
    updater.checkForUpdates.mockRejectedValueOnce(new Error('again'))
    await h.fire()
    expect(h.timers[0].delayMs).toBe(UPDATE_RETRY_DELAYS_MS[0])
  })

  it('does not check while offline and looks again later', async () => {
    const h = harness({ online: false })
    h.service.start()
    await h.fire()

    expect((h.updater as FakeUpdater).checkForUpdates).not.toHaveBeenCalled()
    expect(h.timers[0].delayMs).toBe(300_000)
  })
})
