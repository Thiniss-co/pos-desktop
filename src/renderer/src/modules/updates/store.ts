import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { RestartBlocker, UpdateStatus } from '@shared/contracts/update.contract'
import { UpdatesService } from './service'

export const useUpdatesStore = defineStore('updates', () => {
  const status = ref<UpdateStatus | null>(null)
  const busy = ref(false)
  /** The blockers that refused the cashier's last restart (shown until the next status). */
  const refusedBy = ref<RestartBlocker[] | null>(null)
  let stopListening: (() => void) | null = null

  async function connect(service = new UpdatesService()): Promise<void> {
    if (!stopListening) {
      stopListening = service.onChanged((next) => {
        status.value = next
        if (next.blockers.length === 0) refusedBy.value = null
      })
    }
    try {
      status.value = await service.getStatus()
    } catch {
      status.value = null
    }
  }

  function disconnect(): void {
    stopListening?.()
    stopListening = null
  }

  async function checkNow(service = new UpdatesService()): Promise<void> {
    busy.value = true
    try {
      status.value = await service.checkNow()
    } catch {
      // The status (and its error) is pushed by main.
    } finally {
      busy.value = false
    }
  }

  async function restart(service = new UpdatesService()): Promise<void> {
    busy.value = true
    try {
      const result = await service.restartToInstall()
      refusedBy.value = result.restarting ? null : result.blockers
    } finally {
      busy.value = false
    }
  }

  return { status, busy, refusedBy, connect, disconnect, checkNow, restart }
})
