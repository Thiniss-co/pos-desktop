<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
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
  <div class="activation-page">
    <PageHeader :eyebrow="t('activation.label')" :title="t('activation.title')" />
    <p class="activation-page__description">{{ t('activation.description') }}</p>

    <dl v-if="summary" class="readiness-list">
      <div>
        <dt>{{ t('activation.workstation') }}</dt>
        <dd>{{ summary.deviceName }}</dd>
      </div>
      <div>
        <dt>{{ t('activation.localIdentity') }}</dt>
        <dd class="numeric">{{ summary.deviceUuid }}</dd>
      </div>
      <div>
        <dt>{{ t('activation.platform') }}</dt>
        <dd>{{ summary.platform }} · {{ summary.osVersion }}</dd>
      </div>
    </dl>

    <form class="activation-page__form" @submit.prevent="submit">
      <AppInput v-model="form.companyCode" :label="t('activation.companyCode')" required />
      <AppInput
        v-model="form.activationCode"
        type="password"
        :label="t('activation.activationCode')"
        required
      />
      <AppInput v-model="form.deviceName" :label="t('activation.deviceName')" />

      <AppInlineError v-if="fieldErrors">
        <span v-for="(messages, field) in fieldErrors" :key="field">
          {{ field }}: {{ messages.join(', ') }}
        </span>
      </AppInlineError>

      <AppButton type="submit" :loading="isSubmitting" full-width>
        {{ t('activation.activate') }}
      </AppButton>
    </form>

    <AppInlineError v-if="error">{{ error }}</AppInlineError>
  </div>
</template>

<style scoped>
.activation-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.activation-page__description {
  color: var(--color-on-surface-variant);
  font-size: var(--text-body-lg-size);
}

.activation-page__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
</style>
