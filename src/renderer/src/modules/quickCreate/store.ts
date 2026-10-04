import { ref, watch } from 'vue'
import { defineStore, type Pinia } from 'pinia'
import type {
  QuickCreateAccess,
  QuickCreateCustomerInput,
  QuickCreateProductInput,
  QuickCreateProductOptions,
  QuickCreateRecord,
  QuickCreateResubmitInput,
  QuickCreateSupplierInput
} from '@shared/contracts/quickCreate.contract'
import { unwrapIpcResult } from '../../shared/utils/unwrapIpcResult'
import { useAuthStore } from '../auth/store'

const NONE: QuickCreateAccess = {
  available: false,
  customer: false,
  supplier: false,
  product: false
}

/**
 * POS improvements — register quick-create in the renderer. Every decision (access, owner, entity
 * id, payload) is made in main; this store only reads what main reports and forwards the forms.
 */
export const useQuickCreateStore = defineStore('quickCreate', () => {
  const access = ref<QuickCreateAccess>(NONE)
  const records = ref<QuickCreateRecord[]>([])

  async function loadAccess(): Promise<void> {
    try {
      const result = await window.posApi?.quickCreate?.getAccess()
      access.value = result?.ok ? result.data : NONE
    } catch {
      access.value = NONE
    }
  }

  async function loadRecords(): Promise<void> {
    try {
      const result = await window.posApi?.quickCreate?.list()
      records.value = result?.ok ? result.data : []
    } catch {
      records.value = []
    }
  }

  async function after<T>(work: Promise<T>): Promise<T> {
    const value = await work
    void loadRecords()
    return value
  }

  const api = (): typeof window.posApi.quickCreate => window.posApi.quickCreate

  return {
    access,
    records,
    loadAccess,
    loadRecords,
    createCustomer: async (input: QuickCreateCustomerInput) =>
      after(api().createCustomer(input).then(unwrapIpcResult)),
    createSupplier: async (input: QuickCreateSupplierInput) =>
      after(api().createSupplier(input).then(unwrapIpcResult)),
    createProduct: async (input: QuickCreateProductInput) =>
      after(api().createProduct(input).then(unwrapIpcResult)),
    productOptions: async (): Promise<QuickCreateProductOptions> =>
      unwrapIpcResult(await api().productOptions()),
    retry: async (requestKey: string) => after(api().retry({ requestKey }).then(unwrapIpcResult)),
    reassign: async (requestKey: string) =>
      after(api().reassign({ requestKey }).then(unwrapIpcResult)),
    resubmit: async (input: QuickCreateResubmitInput) =>
      after(api().resubmit(input).then(unwrapIpcResult)),
    clear(): void {
      access.value = NONE
      records.value = []
    }
  }
})

/** Reads access and records on every sign-in, and whenever main reports a change. */
export function startQuickCreateClient(pinia: Pinia): void {
  if (typeof window === 'undefined' || !window.posApi?.quickCreate) {
    return
  }
  const store = useQuickCreateStore(pinia)
  const auth = useAuthStore(pinia)
  watch(
    () => auth.session?.isAuthenticated ?? false,
    (signedIn) => {
      if (signedIn) {
        void store.loadAccess()
        void store.loadRecords()
      } else {
        store.clear()
      }
    },
    { immediate: true }
  )
  window.posApi.quickCreate.onChanged(() => {
    void store.loadAccess()
    void store.loadRecords()
  })
}
