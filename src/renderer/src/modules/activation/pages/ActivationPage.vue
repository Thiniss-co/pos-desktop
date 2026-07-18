<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import { useDeviceStore } from '../store'

const device = useDeviceStore()
const { error, fieldErrors, isSubmitting, summary } = storeToRefs(device)
const startup = useStartupStore()
const router = useRouter()

const form = reactive({
  companyCode: '',
  activationCode: '',
  deviceName: ''
})

onMounted(() => void device.load())

function clearActivationCode(): void {
  form.activationCode = ''
}

onBeforeUnmount(clearActivationCode)

async function submit(): Promise<void> {
  const succeeded = await device.activate({
    companyCode: form.companyCode.trim(),
    activationCode: form.activationCode,
    deviceName: form.deviceName.trim() || undefined
  })

  clearActivationCode()

  if (succeeded) {
    await startup.refresh()
    await router.push({ name: 'login' })
  }
}
</script>

<template>
  <div class="startup-panel">
    <p class="startup-panel__label">01 / device activation</p>
    <h2>Activate this workstation.</h2>
    <p>Enter your company code and activation code to connect this device to your company.</p>
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
    <form class="foundation-form" @submit.prevent="submit">
      <label>
        Company code
        <input v-model="form.companyCode" type="text" autocomplete="off" required />
      </label>
      <label>
        Activation code
        <input v-model="form.activationCode" type="password" autocomplete="off" required />
      </label>
      <label>
        Device name (optional)
        <input v-model="form.deviceName" type="text" autocomplete="off" />
      </label>
      <p v-if="fieldErrors" class="inline-error">
        <span v-for="(messages, field) in fieldErrors" :key="field"
          >{{ field }}: {{ messages.join(', ') }}</span
        >
      </p>
      <button type="submit" :disabled="isSubmitting">
        {{ isSubmitting ? 'Activating…' : 'Activate device' }}
      </button>
    </form>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
  </div>
</template>
