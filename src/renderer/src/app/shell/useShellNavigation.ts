import { computed, type ComputedRef } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { IconName } from '@renderer/shared/components/common/icons.generated'
import { useCompanyUsersStore } from '@renderer/modules/companyUsers/store'

export interface ShellNavItem {
  readonly name: string
  readonly to: string
  readonly icon: IconName
  readonly label: string
  readonly active: boolean
}

/** Route name → the top-level destination it belongs to (sale detail is part of Sales, …). */
const SECTION_OF: Record<string, string> = {
  pos: 'pos',
  sales: 'sales',
  'sale-detail': 'sales',
  sync: 'sync',
  'offline-stock': 'offline-stock',
  settings: 'settings',
  'company-users': 'company-users',
  'company-user-create': 'company-users',
  'company-user-edit': 'company-users'
}

/**
 * The V3 top navigation: POS, Sales, Sync, Offline stock, Settings and — only with the backend's
 * company-users permission — Company users. Shared by the top bar and the compact drawer.
 */
export function useShellNavigation(): { items: ComputedRef<ShellNavItem[]> } {
  const route = useRoute()
  const { t } = useI18n()
  const { access } = storeToRefs(useCompanyUsersStore())

  const items = computed<ShellNavItem[]>(() => {
    const section = SECTION_OF[String(route.name ?? '')] ?? ''
    const all: Array<Omit<ShellNavItem, 'active' | 'label'> & { key: string; visible: boolean }> = [
      { name: 'pos', to: '/pos', icon: 'point_of_sale', key: 'navigation.pos', visible: true },
      { name: 'sales', to: '/sales', icon: 'receipt_long', key: 'navigation.sales', visible: true },
      { name: 'sync', to: '/sync', icon: 'sync', key: 'navigation.sync', visible: true },
      {
        name: 'offline-stock',
        to: '/offline-stock',
        icon: 'inventory_2',
        key: 'navigation.offlineStock',
        visible: true
      },
      {
        name: 'settings',
        to: '/settings',
        icon: 'settings',
        key: 'navigation.settings',
        visible: true
      },
      {
        name: 'company-users',
        to: '/company-users',
        icon: 'group',
        key: 'navigation.companyUsers',
        visible: Boolean(access.value?.canView || access.value?.canManage)
      }
    ]
    return all
      .filter((item) => item.visible)
      .map(({ name, to, icon, key }) => ({
        name,
        to,
        icon,
        label: t(key),
        active: section === name
      }))
  })

  return { items }
}
