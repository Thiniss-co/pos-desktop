// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { UpdateStatus } from '@shared/contracts/update.contract'
import { i18n } from '@renderer/i18n'
import SoftwareUpdatePanel from './SoftwareUpdatePanel.vue'

function status(overrides: Partial<UpdateStatus>): UpdateStatus {
  return {
    phase: 'idle',
    currentVersion: '1.0.0',
    availableVersion: null,
    percent: null,
    lastCheckedAt: '2026-10-09T08:00:00.000Z',
    nextCheckAt: '2026-10-09T12:00:00.000Z',
    errorCode: null,
    blockers: [],
    ...overrides
  }
}

let wrapper: VueWrapper | null = null
let restartToInstall: ReturnType<typeof vi.fn>

async function render(current: UpdateStatus): Promise<VueWrapper> {
  restartToInstall = vi.fn(async () => ({
    ok: true,
    data: { restarting: current.blockers.length === 0, blockers: current.blockers }
  }))
  ;(window as unknown as { posApi: unknown }).posApi = {
    updates: {
      getStatus: vi.fn(async () => ({ ok: true, data: current })),
      checkNow: vi.fn(async () => ({ ok: true, data: current })),
      restartToInstall,
      onChanged: vi.fn(() => () => undefined)
    },
    preferences: { getUser: vi.fn(), setUser: vi.fn() }
  }
  wrapper = mount(SoftwareUpdatePanel, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('Settings: software updates', () => {
  it('says when this installation has no update feed, with nothing to press', async () => {
    const view = await render(status({ phase: 'not_configured' }))

    expect(view.get('[data-testid="update-phase"]').text()).toContain(
      'Automatic updates are not set up'
    )
    expect(view.find('[data-testid="update-check-now"]').exists()).toBe(false)
  })

  it('names what must finish first and keeps the restart disabled', async () => {
    const view = await render(
      status({
        phase: 'ready',
        availableVersion: '1.1.0',
        percent: 100,
        blockers: ['sale_in_progress', 'print_in_progress']
      })
    )

    expect(view.get('[data-testid="update-phase"]').text()).toContain(
      'Version 1.1.0 is ready to install.'
    )
    const blockers = view.get('[data-testid="update-blockers"]').text()
    expect(blockers).toContain('the sale or payment on screen')
    expect(blockers).toContain('a receipt that is printing')
    expect(view.get('[data-testid="update-restart"]').attributes('disabled')).toBeDefined()
  })

  it('restarts only when the cashier asks and nothing would be interrupted', async () => {
    const view = await render(status({ phase: 'ready', availableVersion: '1.1.0', percent: 100 }))

    expect(restartToInstall).not.toHaveBeenCalled()
    await view.get('[data-testid="update-restart"]').trigger('click')
    await flushPromises()
    expect(restartToInstall).toHaveBeenCalledTimes(1)
  })
})
