<script setup lang="ts">
import { onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useDeviceStore } from '../store'

const device = useDeviceStore()
const { error, summary } = storeToRefs(device)

onMounted(() => void device.load())
</script>

<template>
  <div class="startup-panel">
    <p class="startup-panel__label">01 / device activation</p>
    <h2>This workstation is ready to be activated.</h2>
    <p>Activation connects this local identity to your company. That workflow begins in Phase 2.</p>
    <dl v-if="summary" class="readiness-list">
      <div>
        <dt>Workstation</dt>
        <dd>{{ summary.deviceName }}</dd>
      </div>
      <div>
        <dt>Local identity</dt>
        <dd>{{ summary.deviceUuid }}</dd>
      </div>
      <div>
        <dt>Platform</dt>
        <dd>{{ summary.platform }} · {{ summary.osVersion }}</dd>
      </div>
    </dl>
    <p v-if="error" class="inline-error">{{ error }}</p>
  </div>
</template>
