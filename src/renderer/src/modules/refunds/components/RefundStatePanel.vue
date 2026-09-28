<script setup lang="ts">
/**
 * The refund flow's centred state block (V3 prototype "unavailable", "submitting" and "result"):
 * a toned 56px icon disc — or a spinner while a request is in flight — a heading, a body and an
 * optional slot for the amount / support reference. Presentation only.
 */
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppSpinner from '@renderer/shared/components/common/AppSpinner.vue'
import type { IconName } from '@renderer/shared/components/common/icons.generated'

type Tone = 'ok' | 'warn' | 'err' | 'info' | 'neutral'

withDefaults(
  defineProps<{
    title: string
    body?: string
    icon?: IconName
    tone?: Tone
    busy?: boolean
    role?: 'status' | 'alert'
  }>(),
  { body: undefined, icon: 'info', tone: 'neutral', busy: false, role: 'status' }
)

const DISC: Record<Tone, string> = {
  ok: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn',
  err: 'bg-err-bg text-err',
  info: 'bg-info-bg text-info',
  neutral: 'bg-subtle text-muted'
}
</script>

<template>
  <div
    class="flex flex-col items-center gap-2.5 rounded-lg border border-line bg-surf px-6 py-10 text-center"
    :role="role"
  >
    <span v-if="busy" class="text-pri-text">
      <AppSpinner :size="40" />
    </span>
    <span
      v-else
      class="flex size-14 items-center justify-center rounded-full"
      :class="DISC[tone]"
      aria-hidden="true"
    >
      <AppIcon :name="icon" :size="30" />
    </span>
    <h3 class="max-w-[520px] text-xl font-bold text-pretty">{{ title }}</h3>
    <p v-if="body" class="max-w-[560px] text-pretty text-muted">{{ body }}</p>
    <slot />
  </div>
</template>
