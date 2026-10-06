import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import type { CommercialAccessSnapshot } from '@shared/contracts/license.contract'
import { LicenseService } from './service'

/**
 * Phase 3: whether new sales are stopped because the platform suspended the company, from the main process's
 * published commercial-access snapshot (the server is authoritative; main applies the state by revision). A
 * pushed snapshot always wins over the initial read, so a slow first read can never show an older state.
 */
export function useCompanySuspension(service: LicenseService = new LicenseService()): {
  suspended: Ref<boolean>
} {
  const suspended = ref(false)
  let pushed = false
  let unsubscribe: (() => void) | null = null
  const apply = (snapshot: CommercialAccessSnapshot): void => {
    suspended.value = snapshot.sell.reason === 'company-suspended'
  }

  onMounted(() => {
    unsubscribe = service.onAccessChanged((snapshot) => {
      pushed = true
      apply(snapshot)
    })
    service
      .getAccess()
      .then((snapshot) => {
        if (!pushed) apply(snapshot)
      })
      .catch(() => {
        // No snapshot yet (signed out, not bootstrapped): nothing to show.
      })
  })

  onBeforeUnmount(() => unsubscribe?.())

  return { suspended }
}
