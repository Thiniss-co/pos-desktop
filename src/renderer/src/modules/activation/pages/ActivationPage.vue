<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import { useConnectivityStore } from '@renderer/modules/connectivity/store'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import { useDeviceStore } from '../store'

const device = useDeviceStore()
const { error, fieldErrors, isSubmitting, summary } = storeToRefs(device)
const startup = useStartupStore()
const { snapshot } = storeToRefs(useConnectivityStore())
const router = useRouter()
const { t } = useI18n()

const form = reactive({
  companyCode: '',
  activationCode: '',
  deviceName: ''
})

/**
 * Presentation only: the "activation failed" heading belongs to an error raised by a submit, not
 * to the device-summary read error the same store also reports.
 */
const hasAttempted = ref(false)

/** Display-only hint; activation is never blocked on the connectivity snapshot. */
const isDisconnected = computed(
  () => snapshot.value?.status === 'offline' || snapshot.value?.status === 'backend_unreachable'
)

onMounted(() => void device.load())

function clearActivationCode(): void {
  form.activationCode = ''
}

onBeforeUnmount(clearActivationCode)

async function submit(): Promise<void> {
  hasAttempted.value = true
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

const PLATFORM_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform
}
</script>

<template>
  <form class="activation-page flex flex-col gap-4" @submit.prevent="submit">
    <PageHeader :title="t('activation.title')" :description="t('activation.description')" />

    <dl
      v-if="summary"
      class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-notice bg-subtle px-3.5 py-3 text-sm"
    >
      <!-- V3 content rule: no hostnames or OS/app versions on screen — only the platform family
           and the local identity support staff need. -->
      <dt class="text-muted">{{ t('activation.platform') }}</dt>
      <dd class="font-semibold wrap-break-word">{{ platformName(summary.platform) }}</dd>
      <dt class="text-muted">{{ t('activation.localIdentity') }}</dt>
      <dd class="code text-start font-semibold break-all">{{ summary.deviceUuid }}</dd>
    </dl>

    <AppBanner
      v-if="error"
      variant="error"
      role="alert"
      :title="hasAttempted ? t('activation.activationFailed') : undefined"
    >
      {{ error }}
    </AppBanner>

    <AppInput v-model="form.companyCode" :label="t('activation.companyCode')" code required />
    <AppInput
      v-model="form.activationCode"
      type="password"
      :label="t('activation.activationCode')"
      code
      required
    />
    <AppInput v-model="form.deviceName" :label="t('activation.deviceName')" />

    <AppInlineError v-if="fieldErrors">
      <span v-for="(messages, field) in fieldErrors" :key="field" class="block">
        {{ field }}: {{ messages.join(', ') }}
      </span>
    </AppInlineError>

    <AppButton type="submit" size="xl" :loading="isSubmitting" full-width>
      {{ isSubmitting ? t('activation.activating') : t('activation.activate') }}
    </AppButton>

    <p v-if="isDisconnected" class="flex items-center gap-2 text-sm text-muted" role="status">
      <AppIcon name="wifi_off" :size="18" />{{ t('activation.offlineHint') }}
    </p>
    <p class="text-center text-sm text-pretty text-muted">{{ t('activation.help') }}</p>
  </form>
</template>
