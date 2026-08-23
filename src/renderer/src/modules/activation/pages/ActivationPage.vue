<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import { useDeviceStore } from '../store'

const device = useDeviceStore()
const { error, fieldErrors, isSubmitting, summary } = storeToRefs(device)
const startup = useStartupStore()
const router = useRouter()
const { t } = useI18n()

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
    <p class="startup-panel__label">{{ t('activation.label') }}</p>
    <h2>{{ t('activation.title') }}</h2>
    <p>{{ t('activation.description') }}</p>
    <dl v-if="summary" class="readiness-list">
      <div>
        <dt>{{ t('activation.workstation') }}</dt>
        <dd>{{ summary.deviceName }}</dd>
      </div>
      <div>
        <dt>{{ t('activation.localIdentity') }}</dt>
        <dd>{{ summary.deviceUuid }}</dd>
      </div>
      <div>
        <dt>{{ t('activation.platform') }}</dt>
        <dd>{{ summary.platform }} · {{ summary.osVersion }}</dd>
      </div>
    </dl>
    <form class="foundation-form" @submit.prevent="submit">
      <label>
        {{ t('activation.companyCode') }}
        <input v-model="form.companyCode" type="text" autocomplete="off" required />
      </label>
      <label>
        {{ t('activation.activationCode') }}
        <input v-model="form.activationCode" type="password" autocomplete="off" required />
      </label>
      <label>
        {{ t('activation.deviceName') }}
        <input v-model="form.deviceName" type="text" autocomplete="off" />
      </label>
      <p v-if="fieldErrors" class="inline-error">
        <span v-for="(messages, field) in fieldErrors" :key="field"
          >{{ field }}: {{ messages.join(', ') }}</span
        >
      </p>
      <button type="submit" :disabled="isSubmitting">
        {{ isSubmitting ? t('activation.activating') : t('activation.activate') }}
      </button>
    </form>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
  </div>
</template>
