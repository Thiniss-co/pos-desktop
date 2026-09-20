// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
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

/** Every state renders this control at most once — never zero when the panel itself exists. */
function actions(wrapper: VueWrapper): DOMWrapper<Element>[] {
  return wrapper.findAll('[data-testid="catalog-refresh-action"]')
}

afterEach(() => {
  for (const wrapper of wrappers) {
    wrapper.unmount()
  }
  wrappers = []
})

describe('CatalogRefreshPanel', () => {
  it('offers the refresh action for a fresh catalog that has never been refreshed', () => {
    // The incident this component exists to fix: a catalog that looks fine locally can still be
    // missing products the server has since gained, so the action must not depend on anything
    // already looking wrong.
    const wrapper = mountPanel()

    expect(wrapper.find('[data-testid="catalog-refresh-panel"]').exists()).toBe(true)
    expect(actions(wrapper)).toHaveLength(1)
    expect(actions(wrapper)[0].text()).toBe('Refresh workstation data')
    expect(actions(wrapper)[0].attributes('disabled')).toBeUndefined()
  })

  it('lets the cashier initiate a refresh from an empty catalog', async () => {
    // This component has no notion of "empty" beyond the default (nothing stale/pending/erroed/
    // previously refreshed) — the same shape PosPage passes when the local catalog has no products
    // at all. The action must still be clickable.
    const wrapper = mountPanel()

    await actions(wrapper)[0].trigger('click')

    expect(wrapper.emitted('refresh')).toHaveLength(1)
  })

  it('shows the refresh timestamp and one action after a successful prior refresh', () => {
    const wrapper = mountPanel({ lastRefreshedLabel: 'Workstation data refreshed 1 Jan, 02:00' })

    expect(wrapper.find('[data-testid="catalog-refresh-success"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Workstation data refreshed 1 Jan, 02:00')
    expect(actions(wrapper)).toHaveLength(1)
  })

  it('offers exactly one refresh action beside the stale warning', () => {
    const wrapper = mountPanel({ stale: true })

    expect(wrapper.text()).toContain('This catalog is stale')
    expect(actions(wrapper)).toHaveLength(1)
    expect(actions(wrapper)[0].text()).toBe('Refresh workstation data')
  })

  it('shows an actionable error alongside exactly one retry action', () => {
    const wrapper = mountPanel({
      stale: true,
      errorMessage: 'Workstation data could not be refreshed. Check the connection and try again.'
    })

    const error = wrapper.find('[data-testid="catalog-refresh-error"]')
    expect(error.exists()).toBe(true)
    expect(error.attributes('role')).toBe('alert')
    expect(wrapper.text()).toContain('Check the connection and try again')
    // The failure must not strand the cashier: exactly one action stays available (retry below).
    expect(actions(wrapper)).toHaveLength(1)
  })

  it('retrying after an error emits exactly one refresh intent', async () => {
    const wrapper = mountPanel({
      errorMessage: 'Workstation data could not be refreshed. Check the connection and try again.'
    })

    await actions(wrapper)[0].trigger('click')

    expect(wrapper.emitted('refresh')).toHaveLength(1)
  })

  it('emits exactly one refresh intent per click when enabled', async () => {
    const wrapper = mountPanel({ stale: true })

    await actions(wrapper)[0].trigger('click')

    expect(wrapper.emitted('refresh')).toHaveLength(1)
  })

  it('disables the action and shows progress while a refresh is in flight', async () => {
    const wrapper = mountPanel({ pending: true })

    expect(actions(wrapper)).toHaveLength(1)
    const action = actions(wrapper)[0]
    expect(action.attributes('disabled')).toBeDefined()
    expect(action.text()).toBe('Refreshing workstation data…')
    expect(wrapper.find('[data-testid="catalog-refresh-pending"]').exists()).toBe(true)

    // A click on the disabled control cannot start a second refresh.
    await action.trigger('click')
    expect(wrapper.emitted('refresh')).toBeUndefined()
  })

  it('stays disabled and offers one action when pending combines with a stale catalog', async () => {
    const wrapper = mountPanel({ stale: true, pending: true })

    expect(actions(wrapper)).toHaveLength(1)
    const action = actions(wrapper)[0]
    expect(action.attributes('disabled')).toBeDefined()
    expect(action.text()).toBe('Refreshing workstation data…')
    // Priority order: stale still wins the banner slot over the generic pending banner.
    expect(wrapper.text()).toContain('This catalog is stale')

    await action.trigger('click')
    expect(wrapper.emitted('refresh')).toBeUndefined()
  })

  it('stays disabled and offers one action when pending combines with a prior error', async () => {
    const wrapper = mountPanel({
      pending: true,
      errorMessage: 'Workstation data could not be refreshed. Check the connection and try again.'
    })

    expect(actions(wrapper)).toHaveLength(1)
    const action = actions(wrapper)[0]
    expect(action.attributes('disabled')).toBeDefined()
    expect(action.text()).toBe('Refreshing workstation data…')
    expect(wrapper.find('[data-testid="catalog-refresh-error"]').exists()).toBe(true)

    await action.trigger('click')
    expect(wrapper.emitted('refresh')).toBeUndefined()
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
    // The revision-changed notice is additive, not a replacement for the action.
    expect(actions(wrapper)).toHaveLength(1)
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
