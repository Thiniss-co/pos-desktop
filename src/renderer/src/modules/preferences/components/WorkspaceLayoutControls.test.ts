// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { clonePreset } from '@shared/contracts/posWorkspace.contract'
import { i18n } from '@renderer/i18n'
import { useWorkspaceLayoutStore } from '../posWorkspace.store'
import WorkspaceLayoutControls from './WorkspaceLayoutControls.vue'

function checked(wrapper: ReturnType<typeof mount>, testId: string): string | undefined {
  return wrapper
    .get(`[data-testid="${testId}"]`)
    .findAll('[role="radio"]')
    .find((radio) => radio.attributes('aria-checked') === 'true')
    ?.text()
}

describe('WorkspaceLayoutControls', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  async function mountEditing(): Promise<{
    store: ReturnType<typeof useWorkspaceLayoutStore>
    wrapper: ReturnType<typeof mount>
  }> {
    const store = useWorkspaceLayoutStore()
    store.useGateway({
      getPosWorkspace: vi.fn(async () => ({
        layout: clonePreset('balanced'),
        stored: true,
        contextToken: 't'
      })),
      setPosWorkspace: vi.fn(async (input) => ({
        layout: input.layout ?? clonePreset('cartFirst'),
        stored: true,
        contextToken: 't'
      }))
    })
    await store.load()
    store.beginEdit()
    const wrapper = mount(WorkspaceLayoutControls, {
      props: { variant: 'panel' },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    await nextTick()
    return { store, wrapper }
  }

  it('reflects every field of a chosen preset', async () => {
    const { wrapper } = await mountEditing()
    expect(checked(wrapper, 'workspace-view')).toBe(
      String(i18n.global.t('pos.workspace.edit.viewCards'))
    )
    await wrapper
      .get('[data-testid="workspace-preset"]')
      .findAll('[role="radio"]')[2]
      .trigger('click')
    await nextTick()
    expect(checked(wrapper, 'workspace-collapse')).toBe(
      String(i18n.global.t('pos.workspace.edit.productsCollapsed'))
    )
    expect(checked(wrapper, 'workspace-view')).toBe(
      String(i18n.global.t('pos.workspace.edit.viewCompact'))
    )
    expect(wrapper.get('[data-testid="workspace-share"]').text()).toBe('85%')
    wrapper.unmount()
  })

  it('moves sections only into supported orders and announces it', async () => {
    const { store, wrapper } = await mountEditing()
    const cart = wrapper.get('[data-testid="workspace-sections-cart"]')
    const totalsButtons = cart.get('[data-section="totals"]').findAll('button')
    expect(totalsButtons.every((button) => button.attributes('disabled') !== undefined)).toBe(true)
    await cart.get('[data-section="actions"]').findAll('button')[1].trigger('click')
    expect(store.draft?.sections.cart).toEqual(['scan', 'actions', 'lines', 'totals'])
    expect(wrapper.emitted('moved')?.[0]?.[0]).toContain('2')
    wrapper.unmount()
  })

  it('applies once and closes; cancel writes nothing', async () => {
    const { store, wrapper } = await mountEditing()
    await wrapper.get('[data-testid="workspace-cancel"]').trigger('click')
    expect(store.editing).toBe(false)
    expect(wrapper.emitted('cancelled')).toHaveLength(1)
    wrapper.unmount()
  })
})
