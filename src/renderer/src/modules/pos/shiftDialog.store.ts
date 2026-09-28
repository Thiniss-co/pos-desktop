import { ref } from 'vue'
import { defineStore } from 'pinia'

export type ShiftDialogMode = 'open' | 'pause' | 'close'

/**
 * Which shift lifecycle dialog is requested. Pure UI state: the shell's shift menu and the POS
 * page's "Open shift" prompt both request a dialog here, and `ShiftDialogs` (mounted once by the
 * app layout) renders it against the real shift store. It never calls a service.
 */
export const useShiftDialogStore = defineStore('shiftDialog', () => {
  const mode = ref<ShiftDialogMode | null>(null)

  function request(next: ShiftDialogMode): void {
    mode.value = next
  }

  function dismiss(): void {
    mode.value = null
  }

  return { mode, request, dismiss }
})
