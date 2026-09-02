// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import SaleRecoveryBanner from './SaleRecoveryBanner.vue'
import type { DisplayRecoveryResult } from './types'

function baseProps(): InstanceType<typeof SaleRecoveryBanner>['$props'] {
  return {
    blockingAttemptKey: null,
    blockedMessage: 'You have an unresolved sale. Retry or abandon it first.',
    retryLabel: 'Retry',
    abandonLabel: 'Abandon',
    unacknowledgedResults: [],
    unacknowledgedMessage: 'Sale complete',
    acknowledgeLabel: 'Done',
    abandonWarning: 'Abandoning does not mean cash was returned. Verify the till first.',
    confirmAbandonLabel: 'Confirm abandon',
    cancelConfirmLabel: 'Never mind'
  }
}

let wrappers: VueWrapper[] = []

function mountBanner(props: Partial<ReturnType<typeof baseProps>> = {}): VueWrapper {
  const wrapper = mount(SaleRecoveryBanner, {
    props: { ...baseProps(), ...props },
    attachTo: document.body
  })
  wrappers.push(wrapper)
  return wrapper
}

afterEach(() => {
  for (const wrapper of wrappers) {
    wrapper.unmount()
  }
  wrappers = []
})

describe('SaleRecoveryBanner', () => {
  it('renders nothing when there is no blocking attempt and no unacknowledged result', () => {
    mountBanner()

    expect(document.querySelector('[data-testid="sale-recovery-banner"]')).toBeNull()
  })

  it('renders the blocked message and wires retry to the exact blocking attempt key', async () => {
    const wrapper = mountBanner({ blockingAttemptKey: 'stuck-attempt-key' })
    await Promise.resolve()

    expect(document.body.textContent).toContain('unresolved sale')

    const retryButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Retry')
    ) as HTMLButtonElement
    retryButton.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('retry')).toEqual([['stuck-attempt-key']])
    expect(wrapper.emitted('abandon')).toBeUndefined()
  })

  it('requires explicit confirmation with the tender warning before abandon fires, scoped to the exact key', async () => {
    const wrapper = mountBanner({ blockingAttemptKey: 'stuck-attempt-key' })
    await Promise.resolve()

    const abandonButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Abandon')
    ) as HTMLButtonElement
    abandonButton.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('abandon')).toBeUndefined()
    expect(document.body.textContent).toContain('Verify the till first')

    const confirmButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Confirm abandon')
    ) as HTMLButtonElement
    confirmButton.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('abandon')).toEqual([['stuck-attempt-key']])
  })

  it('renders one row per unacknowledged result and acknowledges the exact key clicked', async () => {
    const results: DisplayRecoveryResult[] = [
      { attemptKey: 'key-1', committedAtLabel: 'Today at 10:00' },
      { attemptKey: 'key-2', committedAtLabel: 'Today at 10:05' }
    ]
    const wrapper = mountBanner({ unacknowledgedResults: results })
    await Promise.resolve()

    const doneButtons = Array.from(document.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('Done')
    )
    expect(doneButtons).toHaveLength(2)

    doneButtons[1].click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('acknowledge')).toEqual([['key-2']])
  })

  it('shows both the blocked banner and unacknowledged results together when both exist', async () => {
    mountBanner({
      blockingAttemptKey: 'stuck-attempt-key',
      unacknowledgedResults: [{ attemptKey: 'key-1', committedAtLabel: 'Today at 10:00' }]
    })
    await Promise.resolve()

    expect(document.querySelectorAll('.app-banner')).toHaveLength(2)
  })
})
