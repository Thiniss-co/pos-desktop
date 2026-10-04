import { ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AutoPrintNotice,
  AutoPrintSetup,
  AutoPrintStatus
} from '@shared/contracts/printing.contract'
import { autoPrintSettled } from './autoPrintChip'
import { PrintingService } from './service'

const POLL_MS = 600
const POLL_LIMIT_MS = 120_000

/**
 * POS improvements, Stage 7: the renderer's view of automatic printing -- whether the signed-in
 * user's automatic printing can reach a printer (the setup banner), the recovery notices, and the
 * state of the sale just completed. Main decides everything; this store only reads.
 */
export const useAutoPrintStore = defineStore('autoPrint', () => {
  const service = new PrintingService()
  const identity = ref<string | null>(null)
  const setup = ref<AutoPrintSetup | null>(null)
  const setupDismissed = ref(false)
  const notices = ref<AutoPrintNotice[]>([])
  const sale = ref<{ invoiceLocalUuid: string; status: AutoPrintStatus } | null>(null)
  let pollToken = 0
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  /** A new signed-in user starts with a fresh banner and no inherited notices. */
  function ensureIdentity(next: string | null): void {
    if (identity.value === next) {
      return
    }
    identity.value = next
    setup.value = null
    setupDismissed.value = false
    notices.value = []
    stopWatching()
    sale.value = null
  }

  async function loadSetup(): Promise<void> {
    try {
      setup.value = await service.autoPrintSetup()
    } catch {
      setup.value = null
    }
  }

  async function loadNotices(): Promise<void> {
    try {
      notices.value = await service.autoPrintNotices()
    } catch {
      notices.value = []
    }
  }

  async function dismissNotices(): Promise<void> {
    notices.value = []
    try {
      await service.dismissAutoPrintNotices()
    } catch {
      // Only this session's in-memory list; nothing to recover.
    }
  }

  function dismissSetup(): void {
    setupDismissed.value = true
  }

  function stopWatching(): void {
    pollToken += 1
    if (pollTimer !== null) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  /** Follows one sale until its automatic print is decided and finished (or two minutes pass). */
  async function watchSale(invoiceLocalUuid: string): Promise<void> {
    stopWatching()
    const token = pollToken
    const deadline = Date.now() + POLL_LIMIT_MS
    if (sale.value?.invoiceLocalUuid !== invoiceLocalUuid) {
      sale.value = null
    }
    const tick = async (): Promise<void> => {
      try {
        const status = await service.autoPrintStatus(invoiceLocalUuid)
        if (token !== pollToken) {
          return
        }
        sale.value = { invoiceLocalUuid, status }
        if (autoPrintSettled(status)) {
          return
        }
      } catch {
        if (token !== pollToken) {
          return
        }
      }
      if (Date.now() < deadline) {
        pollTimer = setTimeout(() => void tick(), POLL_MS)
      }
    }
    await tick()
  }

  return {
    setup,
    setupDismissed,
    notices,
    sale,
    ensureIdentity,
    loadSetup,
    loadNotices,
    dismissNotices,
    dismissSetup,
    watchSale,
    stopWatching
  }
})
