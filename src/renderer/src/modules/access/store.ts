import { ref } from 'vue'
import { defineStore } from 'pinia'

export const useAccessStore = defineStore('access', () => {
  const reason = ref('Desktop access is not available for this workstation.')

  return { reason }
})
