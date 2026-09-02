// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import CatalogRefreshPanel from './CatalogRefreshPanel.vue'

function baseProps(): InstanceType<typeof CatalogRefreshPanel>['$props'] {
  return {
    pending: false,
    stale: false,
    staleMessage: 'This catalog is stale. Refresh before starting a new sale.',
    refreshLabel: 'Refresh workstation data',
    pendingLabel: 'Refreshing workstation data…',
    lastRefreshedLabel: null,
    errorMessage: null,
    revisionChangedMessage: null
  }
}

let wrappers: VueWrapper[] = []

function mountPanel(props: Partial<ReturnType<typeof baseProps>> = {}): VueWrapper {
  const wrapper = mount(CatalogRefreshPanel, {
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

describe('CatalogRefreshPanel', () => {
  it('renders nothing when the catalog is current and nothing has been refreshed yet', () => {
    const wrapper = mountPanel()

    expect(wrapper.find('[data-testid="catalog-refresh-panel"]').exists()).toBe(false)
  })

  it('offers the refresh action beside the stale warning', () => {
    const wrapper = mountPanel({ stale: true })

    expect(wrapper.text()).toContain('This catalog is stale')
    const action = wrapper.find('[data-testid="catalog-refresh-action"]')
    expect(action.exists()).toBe(true)
    expect(action.text()).toBe('Refresh workstation data')
  })

  it('emits exactly one refresh intent per click', async () => {
    const wrapper = mountPanel({ stale: true })

    await wrapper.find('[data-testid="catalog-refresh-action"]').trigger('click')

    expect(wrapper.emitted('refresh')).toHaveLength(1)
  })

  it('disables the action and shows progress while a refresh is in flight', async () => {
    const wrapper = mountPanel({ stale: true, pending: true })

    const action = wrapper.find('[data-testid="catalog-refresh-action"]')
    expect(action.attributes('disabled')).toBeDefined()
    expect(action.text()).toBe('Refreshing workstation data…')

    // A double-click on the disabled control cannot start a second refresh.
    await action.trigger('click')
    expect(wrapper.emitted('refresh')).toBeUndefined()
  })

  it('shows progress even when the catalog was not stale to begin with', () => {
    const wrapper = mountPanel({ pending: true })

    expect(wrapper.find('[data-testid="catalog-refresh-pending"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Refreshing workstation data…')
  })

  it('shows the refresh timestamp after a successful refresh', () => {
    const wrapper = mountPanel({ lastRefreshedLabel: 'Workstation data refreshed 1 Jan, 02:00' })

    expect(wrapper.find('[data-testid="catalog-refresh-success"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Workstation data refreshed 1 Jan, 02:00')
  })

  it('shows an actionable error that still offers a retry', async () => {
    const wrapper = mountPanel({
      stale: true,
      errorMessage: 'Workstation data could not be refreshed. Check the connection and try again.'
    })

    const error = wrapper.find('[data-testid="catalog-refresh-error"]')
    expect(error.exists()).toBe(true)
    expect(error.attributes('role')).toBe('alert')
    expect(wrapper.text()).toContain('Check the connection and try again')

    // The failure must not strand the cashier: the action stays available.
    await wrapper.find('[data-testid="catalog-refresh-error"] button').trigger('click')
    expect(wrapper.emitted('refresh')).toHaveLength(1)
  })

  it('warns that a changed revision needs an explicit rebuild or clear', () => {
    const wrapper = mountPanel({
      lastRefreshedLabel: 'Workstation data refreshed 1 Jan, 02:00',
      revisionChangedMessage: 'The refreshed catalog changed. Rebuild or clear the current cart.'
    })

    const notice = wrapper.find('[data-testid="catalog-refresh-revision-changed"]')
    expect(notice.exists()).toBe(true)
    expect(notice.attributes('role')).toBe('alert')
    expect(wrapper.text()).toContain('Rebuild or clear the current cart')
  })

  it('announces the stale warning and the error assertively, and success politely', () => {
    expect(mountPanel({ stale: true }).find('[role="alert"]').exists()).toBe(true)
    expect(
      mountPanel({ stale: true, errorMessage: 'failed' }).find('[role="alert"]').exists()
    ).toBe(true)
    expect(
      mountPanel({ lastRefreshedLabel: 'refreshed' })
        .find('[data-testid="catalog-refresh-success"]')
        .attributes('role')
    ).toBe('status')
  })
})
